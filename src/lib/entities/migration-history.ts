import { PlainClientAPI } from "contentful-management"
import { ContentTypeProps } from "contentful-management/dist/typings/export-types"

export class MigrationHistory {
  public id: string
  public migrationName: string
  public started: number
  public completed?: number
  public detail?: any

  constructor (idOrName: string, fields?: {[key: string]: { 'en-US': any }}) {
    if (!fields) {
      this.migrationName = idOrName
      this.started = Date.now()
      return
    }
    this.id = idOrName
    this.migrationName = fields.migrationName['en-US']

    if (fields.started && fields.started['en-US']) {
      this.started = Date.parse(fields.started['en-US'])
    }
    if (fields.completed && fields.completed['en-US']) {
      this.completed = Date.parse(fields.completed['en-US'])
    }

    this.detail = fields.detail ? fields.detail['en-US'] : undefined

  }

  static structure (params: { spaceId: string, environmentId: string}): ContentTypeProps {
    return {
      "sys": {
        "space": {
          "sys": {
            "type": "Link",
            "linkType": "Space",
            "id": params.spaceId
          }
        },
        "id": "migrationHistory",
        "type": "ContentType",
        "environment": {
          "sys": {
            "id": params.environmentId,
            "type": "Link",
            "linkType": "Environment"
          }
        },
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      displayField: 'migrationName',
      name: 'Migration History',
      description: 'System Type - Do Not Modify',
      fields:
      [ { id: 'migrationName',
        name: 'Migration Name',
        type: 'Symbol',
        localized: false,
        required: true },
      { id: 'started',
        name: 'Started',
        localized: false,
        required: false,
        type: 'Date' },
      { id: 'completed',
        name: 'Completed',
        localized: false,
        required: false,
        type: 'Date' },
      { id: 'detail',
        name: 'Detail',
        localized: false,
        required: false,
        type: 'Object' } ]
    }
  }

  static async getOrCreateContentType (client: PlainClientAPI, params: { spaceId: string, environmentId: string}) {
    try {
      return await client.contentType.get({
        ...params,
        contentTypeId: 'migrationHistory'
      })
    } catch (err) {
      // table doesnt exist, create it and wait for it to propagate in the system
      const data = MigrationHistory.structure(params)
      const type = await client.contentType.update({
          ...params,
          contentTypeId: 'migrationHistory'
        },
        data
      )
      await client.contentType.publish({
          ...params,
          contentTypeId: type.sys.id
        },
        data
      )
      return type
    }
  }

  update<TEntry extends { fields?: Record<string, { 'en-US': any }> }> (entry: TEntry) {
    if (!entry.fields) {
      entry.fields = {}
    }
    entry.fields.migrationName = { 'en-US': this.migrationName }
    entry.fields.started = { 'en-US': new Date(this.started).toISOString() }
    if (this.completed) {
      entry.fields.completed = { 'en-US': new Date(this.completed).toISOString() }
    }
    if (this.detail) {
      entry.fields.detail = { 'en-US': this.detail }
    }
    return entry
  }
}
