import chalk from 'chalk'
import * as path from 'path'
import * as fs from 'fs'
import * as yargs from 'yargs'

import { runMigration, runBatchMigration } from './cli'

const { version } = require('../../package.json')

export default yargs
  .usage('Parses and runs a migration script on a Contentful space.\n\nUsage: contentful-migration [args] <path-to-script-file>\n\nScript: path to a migration script.')
  .command({
    command: 'single <filePath>',
    aliases: ['* <filePath>'],
    desc: 'Run a single migration script',
    handler: runMigration
  })
  .command('batch <directory|glob>', 'Run a set of migration scripts in filename order', {}, runBatchMigration)
  .coerce('filePath', (filePath) => {
    filePath = path.resolve(process.cwd(), filePath)
    if (!fs.existsSync(filePath)) {
      throw new Error(chalk`{bold.red Cannot find file ${filePath}}`)
    }
    if (fs.statSync(filePath).isDirectory()) {
      throw new Error(chalk`{bold.red Cannot load migration file ${filePath}: is a directory.\n  Did you mean to run in 'batch' mode?}`)
    }
    return filePath
  })
  .version(version || 'Version only available on installed package')
  .option('space-id', {
    alias: 's',
    describe: 'ID of the space to run the migration script on'
  }).option('environment-id', {
    alias: 'e',
    describe: 'ID of the environment within the space to run the migration script on',
    default: 'master'
  })
  .option('access-token', {
    alias: 'a',
    describe: 'The access token to use\nThis takes precedence over environment variables or .contentfulrc'
  })
  .option('proxy', {
    describe: 'Proxy configuration in HTTP auth format: [http|https]://host:port or [http|https]://user:password@host:port',
    type: 'string'
  })
  .option('raw-proxy', {
    describe: 'Pass proxy config to Axios instead of creating a custom httpsAgent',
    type: 'boolean',
    default: false
  })
  .option('yes', {
    alias: 'y',
    boolean: true,
    describe: 'Skips any confirmation before applying the migration script',
    default: false
  })
  .option('force', {
    boolean: true,
    describe: 'Re-runs any migrations that previously errored or have already completed.',
    default: false
  })
  .option('persist-to-space', {
    alias: 'p',
    boolean: true,
    describe: 'Persists the fact that this migration ran in a History content-type in the Contentful space',
    default: false
  })
  .demandOption(['space-id'], 'Please provide a space ID')
  .help('h')
  .alias('h', 'help')
  .example('contentful-migration', '--space-id abcedef my-migration.js')
  .strict()
  .argv
