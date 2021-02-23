/**************************************************************************
 *  (C) Copyright ModusBox Inc. 2021 - All rights reserved.               *
 *                                                                        *
 *  This file is made available under the terms of the license agreement  *
 *  specified in the corresponding source code repository.                *
 *                                                                        *
 *  ORIGINAL AUTHOR:                                                      *
 *       Kevin Leyow - kevin.leyow@modusbox.com                         *
 **************************************************************************/

'use strict';

// we use a mock standard components lib to intercept and mock certain funcs
jest.mock('@mojaloop/sdk-standard-components');

const { uuid } = require('uuidv4');
const Model = require('@internal/model').TransfersModel;
const PSM = require('@internal/model/common').PersistentStateMachine;
const { MojaloopRequests } = require('@mojaloop/sdk-standard-components');
const defaultConfig = require('./data/defaultConfig');
const mockLogger = require('../../mockLogger');
const deferredJob = require('@internal/shared').deferredJob;
const pt = require('promise-timeout');
const putTransfersResponse = require('./data/putTransfersResponse.json');

describe('TransfersModel', () => {
    let cacheKey;
    let data;
    let modelConfig;

    const subId = uuid();
    let handler = null;
    beforeEach(async () => {

        modelConfig = {
            logger: mockLogger({app: 'TransfersModel-test'}),

            // there is no need to mock redis but only Cache
            cache: {
                get: jest.fn(() => Promise.resolve(data)),
                set: jest.fn(() => Promise.resolve),

                // mock subscription and store handler
                subscribe: jest.fn(async (channel, h) => {
                    handler = jest.fn(h);
                    return subId;
                }),

                // mock publish and call stored handler
                publish: jest.fn(async (channel, message) => await handler(channel, message, subId)),

                unsubscribe: jest.fn(() => Promise.resolve())
            },
            ...defaultConfig
        };
        data = {
            the: 'mocked data'
        };

        cacheKey = `key-transfers-${uuid()}`;
    });

    describe('create', () => {
        test('proper creation of model', async () => {
            const model = await Model.create(data, cacheKey, modelConfig);

            expect(model.state).toBe('start');

            // model's methods layout
            const methods = [
                'run',
                'getResponse',
                'onRequestAction'
            ];

            methods.forEach((method) => expect(typeof model[method]).toEqual('function'));
        });
    });

    describe('getResponse', () => {

        it('should remap currentState', async () => {
            const model = await Model.create(data, cacheKey, modelConfig);
            const states = model.allStates();
            // should remap for all states except 'init' and 'none'
            states.filter((s) => s !== 'init' && s !== 'none').forEach((state) => {
                model.context.data.currentState = state;
                const result = model.getResponse();
                expect(result.currentState).toEqual(Model.mapCurrentState[state]);
            });

        });

        it('should handle unexpected state', async() => {
            const model = await Model.create(data, cacheKey, modelConfig);

            // simulate lack of state by undefined property
            delete model.context.data.currentState;

            const resp = model.getResponse();
            expect(resp.currentState).toEqual(Model.mapCurrentState.errored);

            // ensure that we log the problem properly
            expect(modelConfig.logger.error).toHaveBeenCalledWith(`TransfersModel model response being returned from an unexpected state: ${undefined}. Returning ERROR_OCCURRED state`);
        });
    });

    describe('channelName', () => {
        it('should validate input', () => {
            expect(Model.channelName({})).toEqual('transfers-undefined');
        });

        it('should generate proper channel name', () => {
            const transferId = uuid();
            expect(Model.channelName({ transferId })).toEqual(`transfers-${transferId}`);
        });

    });

    describe('generateKey', () => {
        it('should generate proper cache key', () => {
            const transferId = uuid();
            expect(Model.generateKey({ transferId })).toEqual(`key-${Model.channelName({ transferId })}`);
        });

        it('should handle lack of transferId param', () => {
            expect(() => Model.generateKey({ })).toThrowError(new Error('TransfersModel args requires \'transferId\' is nonempty string and mandatory property'));
        });

    });

    describe('onRequestAction', () => {

        it('should implement happy flow', async (done) => {
            const transferId = uuid();
            const fspId = uuid();
            // our code takes care only about 'transferId' property
            const transfer = { transferId };
            const channel = Model.channelName({ transferId });
            const model = await Model.create(data, cacheKey, modelConfig);
            const { cache } = model.context;
            // mock workflow execution which is tested in separate case
            model.run = jest.fn(() => Promise.resolve());

            const message = { ...putTransfersResponse };

            // manually invoke transition handler
            model.onRequestAction(model.fsm, { transferId, fspId, transfer })
                .then(() => {
                    // subscribe should be called only once
                    expect(cache.subscribe).toBeCalledTimes(1);

                    // subscribe should be done to proper notificationChannel
                    expect(cache.subscribe.mock.calls[0][0]).toEqual(channel);

                    // check invocation of request.getParties
                    expect(MojaloopRequests.__postTransfers).toBeCalledWith(transfer, fspId);

                    // check that this.context.data is updated
                    expect(model.context.data).toEqual({
                        transfers: { ...message },
                        // current state will be updated by onAfterTransition which isn't called
                        // when manual invocation of transition handler happens
                        currentState: 'start'
                    });
                    // handler should be called only once
                    expect(handler).toBeCalledTimes(1);

                    // handler should unsubscribe from notification channel
                    expect(cache.unsubscribe).toBeCalledTimes(1);
                    expect(cache.unsubscribe).toBeCalledWith(channel, subId);
                    done();
                });

            // ensure handler wasn't called before publishing the message
            expect(handler).not.toBeCalled();

            // ensure that cache.unsubscribe does not happened before fire the message
            expect(cache.unsubscribe).not.toBeCalled();

            // fire publication with given message
            const df = deferredJob(cache, channel);
            setImmediate(() => df.trigger(message));

        });

        it('should handle timeouts', async (done) => {
            const transferId = uuid();
            const fspId = uuid();
            // our code takes care only about 'transferId' property
            const transfer = { transferId };
            const channel = Model.channelName({ transferId });

            const model = await Model.create(data, cacheKey, modelConfig);
            const { cache } = model.context;
            // mock workflow execution which is tested in separate case
            model.run = jest.fn(() => Promise.resolve());

            const message = { ...putTransfersResponse };

            // manually invoke transition handler
            model.onRequestAction(model.fsm, { transferId, fspId, transfer })
                .catch((err) => {
                    // subscribe should be called only once
                    expect(err instanceof pt.TimeoutError).toBeTruthy();

                    // subscribe should be done to proper notificationChannel
                    expect(cache.subscribe.mock.calls[0][0]).toEqual(channel);

                    // check invocation of request.getParties
                    expect(MojaloopRequests.__postTransfers).toBeCalledWith(transfer, fspId);

                    // handler should be called only once
                    expect(handler).toBeCalledTimes(0);

                    // handler should unsubscribe from notification channel
                    expect(cache.unsubscribe).toBeCalledTimes(1);
                    expect(cache.unsubscribe).toBeCalledWith(channel, subId);
                    done();
                });

            // ensure handler wasn't called before publishing the message
            expect(handler).not.toBeCalled();

            // ensure that cache.unsubscribe does not happened before fire the message
            expect(cache.unsubscribe).not.toBeCalled();

            // fire publication with given message
            const df = deferredJob(cache, channel);

            setTimeout(
                () => { df.trigger(message); },
                // ensure that publication will be far long after timeout should be auto triggered
                (modelConfig.requestProcessingTimeoutSeconds+1)*1000
            );

        });

        it('should unsubscribe from cache in case when error happens in workflow run', async (done) => {
            const transferId = uuid();
            const fspId = uuid();
            // our code takes care only about 'transferId' property
            const transfer = { transferId };
            const channel = Model.channelName({ transferId });
            const model = await Model.create(data, cacheKey, modelConfig);
            const { cache } = model.context;

            // invoke transition handler
            model.onRequestAction(model.fsm, { transferId, fspId, transfer }).catch((err) => {
                expect(err.message).toEqual('Unexpected token u in JSON at position 0');
                expect(cache.unsubscribe).toBeCalledTimes(1);
                expect(cache.unsubscribe).toBeCalledWith(channel, subId);
                done();
            });

            // fire publication to channel with invalid message
            // should throw the exception from JSON.parse
            const df = deferredJob(cache, channel);
            setImmediate(() => df.trigger(undefined));
        });

        it('should unsubscribe from cache in case when error happens Mojaloop requests', async (done) => {
            // simulate error
            MojaloopRequests.__postTransfers = jest.fn(() => Promise.reject('postTransfers failed'));
            const transferId = uuid();
            const fspId = uuid();
            // our code takes care only about 'transferId' property
            const transfer = { transferId };
            const channel = Model.channelName({ transferId });
            const model = await Model.create(data, cacheKey, modelConfig);
            const { cache } = model.context;

            let theError = null;
            // invoke transition handler
            try {
                await model.onRequestAction(model.fsm, { transferId, fspId, transfer });
                throw new Error('this point should not be reached');
            } catch (error) {
                theError = error;
                expect(theError).toEqual('postTransfers failed');
                // handler should unsubscribe from notification channel
                expect(cache.unsubscribe).toBeCalledTimes(1);
                expect(cache.unsubscribe).toBeCalledWith(channel, subId);
                done();
            }
        });

    });

    describe('run workflow', () => {
        it('start', async () => {
            const transferId = uuid();
            const fspId = uuid();
            // our code takes care only about 'transferId' property
            const transfer = { transferId };

            const model = await Model.create(data, cacheKey, modelConfig);

            model.requestAction = jest.fn();
            model.getResponse = jest.fn(() => Promise.resolve({the: 'response'}));

            model.context.data.currentState = 'start';
            const result = await model.run({ transferId, fspId, transfer });
            expect(result).toEqual({the: 'response'});
            expect(model.requestAction).toBeCalledTimes(1);
            expect(model.getResponse).toBeCalledTimes(1);
            expect(model.context.logger.log.mock.calls).toEqual([
                ['State machine transitioned \'init\': none -> start'],
                ['Action called successfully'],
                [`Persisted model in cache: ${cacheKey}`],
            ]);
        });
        it('succeeded', async () => {
            const transferId = uuid();
            const fspId = uuid();
            // our code takes care only about 'transferId' property
            const transfer = { transferId };

            const model = await Model.create(data, cacheKey, modelConfig);

            model.getResponse = jest.fn(() => Promise.resolve({the: 'response'}));

            model.context.data.currentState = 'succeeded';
            const result = await model.run({ transferId, fspId, transfer });

            expect(result).toEqual({the: 'response'});
            expect(model.getResponse).toBeCalledTimes(1);
            expect(model.context.logger.log).toBeCalledWith('Action called successfully');
        });

        it('errored', async () => {
            const transferId = uuid();
            const fspId = uuid();
            // our code takes care only about 'transferId' property
            const transfer = { transferId };

            const model = await Model.create(data, cacheKey, modelConfig);

            model.getResponse = jest.fn(() => Promise.resolve({the: 'response'}));

            model.context.data.currentState = 'errored';
            const result = await model.run({ transferId, fspId, transfer});

            expect(result).toBeFalsy();
            expect(model.getResponse).not.toBeCalled();
            expect(model.context.logger.log).toBeCalledWith('State machine in errored state');
        });

        it('handling errors', async (done) => {
            const transferId = uuid();
            const fspId = uuid();
            // our code takes care only about 'transferId' property
            const transfer = { transferId };

            const model = await Model.create(data, cacheKey, modelConfig);

            model.requestAction = jest.fn(() => { throw new Error('mocked error'); });

            model.context.data.currentState = 'start';

            model.run({ transferId, fspId, transfer }).catch((err) => {
                expect(model.context.data.currentState).toEqual('errored');
                expect(err.requestActionState).toEqual( {
                    ...data,
                    currentState: 'ERROR_OCCURRED',
                });
                done();
            });
        });
        it('should handle errors', async () => {
            const transferId = uuid();
            const fspId = uuid();
            // our code takes care only about 'transferId' property
            const transfer = { transferId };

            const model = await Model.create(data, cacheKey, modelConfig);

            model.requestAction = jest.fn(() => {
                const err = new Error('requestAction failed');
                err.requestActionState = 'some';
                return Promise.reject(err);
            });
            model.error = jest.fn();
            model.context.data.currentState = 'start';

            let theError = null;
            try {
                await model.run({ transferId, fspId, transfer });
                throw new Error('this point should not be reached');
            } catch(error) {
                theError = error;
            }
            // check propagation of original error
            expect(theError.message).toEqual('requestAction failed');

            // ensure we start transition to errored state
            expect(model.error).toBeCalledTimes(1);
        });

        it('should handle input validation for lack of transferId param', async () => {
            const model = await Model.create(data, cacheKey, modelConfig);

            expect(() => model.run({}))
                .rejects.toEqual(
                    new Error('TransfersModel args requires \'transferId\' is nonempty string and mandatory property')
                );
        });

        it('should handle input validation for not transferId & transfer.transferId be in sync', async () => {
            const transferId = uuid();
            const model = await Model.create(data, cacheKey, modelConfig);

            expect(() => model.run({transferId, transfer: { transferId: uuid()}}))
                .rejects.toEqual(
                    new Error('TransfersModel args requires properties \'transfer.transferId\' and \'transferId\' to be the equal in value')
                );
        });

        it('should handle input validation for fspId param', async () => {
            const transferId = uuid();
            const model = await Model.create(data, cacheKey, modelConfig);

            expect(() => model.run({transferId, fspId:'' }))
                .rejects.toEqual(
                    new Error('TransfersModel args requires \'fspId\' to be nonempty string')
                );
        });

    });

    describe('loadFromCache', () => {
        test('should use PSM.loadFromCache properly', async () => {
            const spyLoadFromCache = jest.spyOn(PSM, 'loadFromCache');
            const key = uuid();

            // act
            const model = await Model.loadFromCache(key, modelConfig);

            // assert
            // check does model is proper
            expect(typeof model.requestAction).toEqual('function');

            // check how cache.get has been called
            expect(modelConfig.cache.get).toBeCalledWith(key);

            // check how loadFromCache from parent PSM module was used
            expect(spyLoadFromCache).toBeCalledTimes(1);
            expect(spyLoadFromCache).toBeCalledWith(
                modelConfig.cache,
                key,
                modelConfig.logger,
                expect.anything(),
                expect.anything()
            );
        });
    });
});