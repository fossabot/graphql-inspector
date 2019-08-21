import * as knex from 'knex';
import {
  createTables,
  Tables,
  OperationModel,
  FieldModel,
  OperationFieldModel,
  OperationTraceModel,
  FieldTraceModel,
  ErrorModel,
} from './models';
import {Report, Trace} from '../../types';
import {operationSignature} from '../../normalize/operation';
import {
  normalizeTraceNode,
  NormalizedTraceNodeMap,
} from '../../normalize/trace';
import {flatten} from '../../helpers';

export interface PostgreSQLAdapterConfig {
  connection: knex.ConnectionConfig | string;
  debug?: boolean;
}

export class PostgreSQLAdapter {
  private _client!: knex;
  private config: PostgreSQLAdapterConfig;

  constructor(config: PostgreSQLAdapterConfig) {
    this.config = {
      debug: false,
      ...config,
    };
  }

  async init(): Promise<void> {
    this._client = knex({client: 'pg', connection: this.config.connection});
    await createTables(this.client);
  }

  get client() {
    if (!this._client) {
      throw new Error('Remember to init()');
    }

    return this._client;
  }

  async writeReport(report: Report): Promise<void> {
    this.debug('Writing report');
    // 1. Insert operation
    //  1.1. Check if exists in Tables.Operations
    //  1.2. Insert if not, otherwise get the ID
    //
    // 2. Iterate through fields
    //  2.1. Flatten them and add a path
    //  2.2. If operation exists, fields are there, otherwise insert them
    //
    // 3. Insert traces for an operation
    //
    // 4. Insert each field trace
    //
    // 5. Insert errors for an operation and fields at the same time
    await Promise.all(report.traces.map(trace => this.writeTrace(trace)));
  }

  async readFields(): Promise<FieldModel[]> {
    return this.client<FieldModel>(Tables.Fields).select('*');
  }

  async readOperations(): Promise<OperationModel[]> {
    return this.client<OperationModel>(Tables.Operations).select('*');
  }

  async readOperationTraces(): Promise<OperationTraceModel[]> {
    return this.client<OperationTraceModel>(Tables.OperationTraces).select('*');
  }

  async readFieldTraces(): Promise<FieldTraceModel[]> {
    return this.client<FieldTraceModel>(Tables.FieldTraces).select('*');
  }

  async readErrors(): Promise<ErrorModel[]> {
    return this.client<ErrorModel>(Tables.Errors).select('*');
  }

  private async writeTrace(trace: Trace) {
    this.debug('Writing a trace');
    const signature = operationSignature({
      document: trace.query!,
      operationName: trace.operationName!,
    });

    this.debug(`Using signature: ${signature}`);

    // check if operation exists
    const [existingOperation] = await this.client<OperationModel>(
      Tables.Operations,
    )
      .select('id')
      .where({signature});

    let operationId: number;

    if (existingOperation) {
      this.debug('Operation already exists');
      operationId = existingOperation.id;
    } else {
      // create one if not
      const [newOperationId] = await this.client<OperationModel>(
        Tables.Operations,
      )
        .insert({
          operation: trace.query,
          name: trace.operationName,
          signature,
        })
        .returning('id');

      operationId = newOperationId;

      this.debug('Created a new operation');
    }

    const traceNodeMap = normalizeTraceNode(trace.entry);
    const fieldIdMap = await this.ensureFieldIdMap(traceNodeMap);

    // assign fields to operation
    if (!existingOperation) {
      this.debug('Assigning fields to an operation');
      await this.client<OperationFieldModel>(Tables.OperationsFields).insert(
        Object.values(fieldIdMap).map(fieldId => {
          return {
            fieldId,
            operationId,
          };
        }),
      );
    }

    // instert operation trace
    this.debug('Inserting an operation trace');
    const [operationTraceId] = await this.client<OperationTraceModel>(
      Tables.OperationTraces,
    )
      .insert({
        operationId,
        startTime: trace.startTime,
        duration: trace.duration,
        parsing: trace.parsing,
        validation: trace.validation,
        execution: trace.execution,
      })
      .returning('id');

    const nodes = flatten(Object.values(traceNodeMap));

    // insert field traces
    this.debug('Inserting field traces');
    const fieldTraceIds = await this.client<FieldTraceModel>(Tables.FieldTraces)
      .insert(
        nodes.map(node => {
          const fieldId = fieldIdMap[`${node.parentType}.${node.field}`];

          return {
            path: node.path.join('.'),
            fieldId,
            operationTraceId,
            startTime: node.startTime,
            endTime: node.endTime,
          };
        }),
      )
      .returning('id');

    // insert errors for an operation
    this.debug('Inserting operation errors');
    if (trace.entry.errors.length) {
      await this.client<ErrorModel>(Tables.Errors).insert(
        trace.entry.errors.map(error => {
          return {
            operationTraceId,
            message: error.message,
            json: error.json,
          };
        }),
      );
    }

    // insert errors for each field
    this.debug('Inserting field errors');
    await this.client<ErrorModel>(Tables.Errors).insert(
      flatten(
        nodes
          .filter(node => node.errors.length)
          .map((node, i) => {
            const fieldTraceId = fieldTraceIds[i];

            return node.errors.map(error => {
              return {
                fieldTraceId,
                message: error.message,
                json: error.json,
              };
            });
          }),
      ),
    );
  }

  private async ensureFieldIdMap(traceNodeMap: NormalizedTraceNodeMap) {
    const typeFieldPairs = Object.keys(traceNodeMap).map<[string, string]>(
      i => i.split('.') as [string, string],
    );

    const ids = await Promise.all(
      typeFieldPairs.map(async ([type, field]) => {
        // check if field is there
        const [fieldResult] = await this.client<FieldModel>(Tables.Fields)
          .select('id')
          .where({
            type,
            name: field,
          });

        if (fieldResult) {
          return fieldResult.id;
        }

        // create new one
        this.debug('Inserting a new field');
        const [newFieldId] = await this.client<FieldModel>(Tables.Fields)
          .insert({
            type,
            name: field,
          })
          .returning('id');

        return newFieldId;
      }),
    );

    return typeFieldPairs.reduce<Record<string, number>>(
      (acc, [type, field], i) => {
        return {
          ...acc,
          [`${type}.${field}`]: ids[i],
        };
      },
      {},
    );
  }

  private debug(msg: string) {
    if (this.config.debug) {
      console.log(msg);
    }
  }
}