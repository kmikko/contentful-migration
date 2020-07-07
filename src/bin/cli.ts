import * as path from 'path'
import globby from 'globby'

import chalk from 'chalk'
import * as fs from 'fs'
import * as inquirer from 'inquirer'
import Listr from 'listr'
import { createManagementClient } from './lib/contentful-client'
const { version } = require('../../package.json')
const {
  SpaceAccessError
} = require('../lib/errors')
import createMigrationParser, { ParseResult } from '../lib/migration-parser'
import { renderPlan, renderValidationErrors, renderRuntimeErrors } from './lib/render-migration'
import renderStepsErrors from './lib/steps-errors'
import writeErrorsToLog from './lib/write-errors-to-log'
import { RequestBatch } from '../lib/offline-api/index'
import Fetcher from '../lib/fetcher'
import { MigrationHistory } from '../lib/entities/migration-history'
import { getConfig } from './lib/config'
import ValidationError from '../lib/interfaces/errors'

class ManyError extends Error {
  public errors: (Error | ValidationError)[]
  constructor (message: string, errors: (Error | ValidationError)[]) {
    super(message)
    this.errors = errors
  }
}

class BatchError extends Error {
  public batch: RequestBatch
  public errors: Error[]
  constructor (message: string, batch: RequestBatch, errors: Error[]) {
    super(message)
    this.batch = batch
    this.errors = errors
  }
}

type TerminatingFunction = (error: Error) => void
const makeTerminatingFunction = ({ shouldThrow }) => (error: Error) => {
  if (shouldThrow) {
    throw error
  } else {
    process.exit(1)
  }
}

const createRun = ({ shouldThrow }) => async function runSingle (argv) {
  const terminate = makeTerminatingFunction({ shouldThrow })
  const migrationFunction = loadMigrationFunction(argv.filePath, terminate)

  const spaceId = argv.spaceId
  const environmentId = argv.environmentId
  const application = argv.managementApplication || `contentful.migration-cli/${version}`
  const feature = argv.managementFeature || `migration-library`

  const config: IRunConfig = {
    accessToken: argv.accessToken,
    spaceId,
    environmentId,
    application,
    feature,
    persistToSpace: argv.persistToSpace,
    quiet: argv.quiet,
    yes: argv.yes
  }

  const client = createClient(config)
  const history = await client.fetcher.getMigrationHistory()
  const migrationName = path.basename(migrationFunction.filePath)

  let thisMigrationHistory = history.filter(m => m.migrationName === migrationName && m.completed).pop()
  if (thisMigrationHistory) {
    console.error(chalk`{gray Migration previously completed at ${new Date(thisMigrationHistory.completed).toString()}}`)
    if (!argv.force) {
      return
    }
    console.error(chalk`  {gray Re-running migration anyways due to "--force" parameter}`)
  } else {
    thisMigrationHistory = history.filter(m => m.migrationName === migrationName).pop()
    if (thisMigrationHistory) {
      console.error(chalk`⚠️  {bold.yellow Migration failed before completion at ${new Date(thisMigrationHistory.started).toString()}}`)
      if (!argv.force) {
        console.error(chalk`  {bold.yellow Please manually inspect the data model for errors and then re-run using "--force"}`)
        return
      }
      console.error(chalk`  {gray Re-running migration anyways due to "--force" parameter}`)
    }
  }

  await execMigration(migrationFunction, config, client, terminate)
}

const createRunBatch = ({ shouldThrow }) => async function runBatch (argv) {
  const terminate = makeTerminatingFunction({ shouldThrow })
  const application = argv.managementApplication || `contentful.migration-cli/${version}`
  const feature = argv.managementFeature || `migration-library`
  const config: IRunConfig = Object.assign({
    application,
    feature,
    persistToSpace: argv.persistToSpace,
    quiet: argv.quiet,
    yes: argv.yes
  }, getConfig(argv))

  let migrationFunctions = []
  let glob
  if (argv.directory) {
    const stats = fs.statSync(argv.directory)
    if (stats.isDirectory()) {
      const extensions = ['js', 'ts']
      glob = path.join(argv.directory, `[0-9]*@(${extensions.join('|')})`)
    }
  }
  if (!glob) {
    glob = argv.glob
  }
  const files = await globby(glob)
  files.sort()

  migrationFunctions.push(...files.map(f => loadMigrationFunction(path.resolve(process.cwd(), f), terminate)))

  const client = createClient(config)
  const history = await client.fetcher.getMigrationHistory()

  if (migrationFunctions.length === 0) {
    console.error(chalk`{bold.yellow No migrations found in ${glob}}`)
  } else {
    for (let i = 0; i < migrationFunctions.length; i++) {
      const migration = migrationFunctions[i]

      const migrationName = path.basename(migration.filePath)
      let thisMigrationHistory = history.filter(m => m.migrationName === migrationName && m.completed).pop()
      if (thisMigrationHistory) {
        console.error(chalk`{gray Migration ${(i + 1).toString()}: ${migrationName}\n  previously completed at ${new Date(thisMigrationHistory.completed).toString()}}`)
      } else {
        thisMigrationHistory = history.filter(m => m.migrationName === migrationName).pop()
        if (thisMigrationHistory) {
          console.error(chalk`⚠️  {bold.yellow Migration ${(i + 1).toString()}: ${migrationName}\n  failed before completion at ${new Date(thisMigrationHistory.started).toString()}}`)
          if (!argv.force) {
            console.error(chalk`  {bold.yellow   Please manually inspect the data model for errors and then re-run using "--force"}`)
            return
          }
          console.error(chalk`  {bold.yellow   Re-running migration anyways due to "--force" parameter}`)
        }
        console.error(chalk`{bold.cyan Migration ${(i + 1).toString()}: ${migrationName}}`)
        await execMigration(migration, config, client, terminate)
      }
    }
  }
}

function createClient (config: IRunConfig) {
  const clientConfig = Object.assign({}, config)

  const client = createManagementClient(clientConfig)
  const makeRequest = function (requestConfig) {
    const cfg = Object.assign({}, requestConfig, {
      url: [clientConfig.spaceId, 'environments', clientConfig.environmentId, requestConfig.url].join('/')
    })
    return client.rawRequest(cfg)
  }

  const fetcher = new Fetcher(makeRequest)
  return { client, makeRequest, fetcher }
}

async function execMigration (migrationFunction, config: IRunConfig, { client, makeRequest }, terminate: TerminatingFunction) {

  const migrationName = path.basename(migrationFunction.filePath)
  const errorsFile = path.join(
    process.cwd(),
    `errors-${migrationName}-${Date.now()}.log`
  )

  const migrationParser = createMigrationParser(makeRequest, config)

  let parseResult: ParseResult

  try {
    parseResult = await migrationParser(migrationFunction)
  } catch (e) {
    if (e instanceof SpaceAccessError) {
      const message = [
        chalk`{red.bold ${e.message}}\n`,
        chalk`�  {bold.red Migration unsuccessful}`
      ].join('\n')
      console.error(message)
      terminate(new Error(message))
    }
    console.error(e)
    terminate(e)
  }

  if (parseResult.hasStepsValidationErrors()) {
    renderStepsErrors(parseResult.stepsValidationErrors)
    terminate(new ManyError('Step Validation Errors', parseResult.stepsValidationErrors))
  }

  if (parseResult.hasPayloadValidationErrors()) {
    renderStepsErrors(parseResult.payloadValidationErrors)
    terminate(new ManyError('Payload Validation Errors', parseResult.payloadValidationErrors))
  }

  const batches = parseResult.batches

  if (parseResult.hasValidationErrors()) {
    renderValidationErrors(batches, config.environmentId)
    terminate(new ManyError('Validation Errors', parseResult.getValidationErrors()))
  }

  if (parseResult.hasRuntimeErrors()) {
    renderRuntimeErrors(batches, errorsFile)
    await writeErrorsToLog(parseResult.getRuntimeErrors(), errorsFile)
    terminate(new ManyError('Runtime Errors', parseResult.getRuntimeErrors()))
  }

  await renderPlan(batches, config.environmentId, config.quiet)

  const serverErrorsWritten = []

  const tasks = batches.map((batch) => {
    return {
      title: batch.intent.toPlanMessage().heading,
      task: () => new Listr([
        {
          title: 'Making requests',
          task: async (_ctx, task) => {
            // TODO: We wanted to make this an async interator
            // So we should not inspect the length but have a property for that
            const numRequests = batch.requests.length
            const requestErrors = []
            let requestsDone = 0
            for (const request of batch.requests) {
              requestsDone += 1
              task.title = `Making requests (${requestsDone}/${numRequests})`
              task.output = `${request.method} ${request.url} at V${request.headers['X-Contentful-Version']}`

              await makeRequest(request).catch((error) => {
                serverErrorsWritten.push(writeErrorsToLog(error, errorsFile))
                let errorMessage

                if (error instanceof TypeError) {
                  errorMessage = {
                    message: 'Value does not match the expected type',
                    details: {
                      message: error.message.toString()
                    }
                  }
                } else {
                  const parsed = JSON.parse(error.message)

                  errorMessage = {
                    status: parsed.statusText,
                    message: parsed.message,
                    details: parsed.details,
                    url: parsed.request.url
                  }
                }

                requestErrors.push(new Error(JSON.stringify(errorMessage)))
              })
            }
            // Finish batch and only then throw all errors in there
            if (requestErrors.length) {
              throw new BatchError(`Batch failed`, batch, requestErrors)
            }
          }
        }
      ])
    }
  })

  const space = await client.getSpace(config.spaceId)
  const environment = await space.getEnvironment(config.environmentId)

  let thisMigrationHistory
  if (config.persistToSpace) {
    tasks.splice(0, 0, {
      title: `Insert Migration "${migrationName}" into History`,
      task: async () => {
        await MigrationHistory.getOrCreateContentType(environment)

        thisMigrationHistory = new MigrationHistory(migrationName)
        thisMigrationHistory.detail = batches
        const resp = await environment.createEntry('migrationHistory', thisMigrationHistory.update({}))
        thisMigrationHistory.id = resp.sys.id
      }
    })

    tasks.push({
      title: 'Mark migration as completed',
      task: async () => {
        thisMigrationHistory.completed = Date.now()
        let entry = await environment.getEntry(thisMigrationHistory.id)
        thisMigrationHistory.update(entry)
        entry = await entry.update()
        entry = await entry.publish()
      }
    })
  }

  const confirm = async function (options: { skipConfirmation: boolean }) {
    if (options.skipConfirmation) {
      return { applyMigration: true }
    }

    return inquirer.prompt([{
      type: 'confirm',
      message: 'Do you want to apply the migration',
      name: 'applyMigration'
    }])
  }

  const answers = await confirm({ skipConfirmation: config.yes })

  if (answers.applyMigration) {
    try {
      const successfulMigration = await (new Listr(tasks)).run()
      console.error(chalk`�  {bold.green Migration successful}`)
      return successfulMigration
    } catch (err) {
      console.error(chalk`�  {bold.red Migration unsuccessful}`)
      console.error(chalk`{red ${err.message}}\n`)
      err.errors.forEach((err) => console.error(chalk`{red ${err}}\n\n`))
      await Promise.all(serverErrorsWritten)
      console.error(`Please check the errors log for more details: ${errorsFile}`)
      terminate(err)
    }
  } else {
    console.error(chalk`⚠️  {bold.yellow Migration aborted}`)
  }
}

export const runMigration = createRun({ shouldThrow: true })
export default createRun({ shouldThrow: false })
export const runBatchMigration = createRunBatch({ shouldThrow: true })

function loadMigrationFunction (filePath, terminate) {
  try {
    const ret = require(filePath)
    ret.filePath = filePath
    return ret
  } catch (e) {
    const message = chalk`{red.bold The ${filePath} script could not be parsed, as it seems to contain syntax errors.}\n`
    console.error(message)
    terminate(new Error(message))
  }
}

interface IRunConfig {
  accessToken?: string,
  spaceId?: string,
  environmentId?: string,
  application: string,
  feature: string,
  persistToSpace: boolean,
  quiet: boolean,
  yes: boolean
}
