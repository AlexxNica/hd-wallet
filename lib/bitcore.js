/* @flow
 * Interface to bitcore-node blockchain backend
 */

import 'whatwg-fetch';

import { Stream } from './utils/stream';
import { Socket } from './socketio-worker/outside';
import { deferred } from './utils/deferred';

import type { Deferred } from './utils/deferred';

export type SyncStatus = { height: number; };

export type TransactionWithHeight = {
    hex: string;
    height: ?number;
    timestamp: ?number;
    hash: string;
    inputAddresses: Array<?string>;
    outputAddresses: Array<?string>;
}

export type Blockchain = {
    errors: Stream<Error>;
    notifications: Stream<TransactionWithHeight>;
    blocks: Stream<void>;

    workingUrl: string;

    subscribe(addresses: Set<string>): void;
    lookupTransactionsStream(
        addresses: Array<string>,
        start: number,
        end: number
    ): Stream<Array<TransactionWithHeight> | Error>;
    lookupTransactions(
        addresses: Array<string>,
        start: number,
        end: number
    ): Promise<Array<TransactionWithHeight>>;
    lookupTransaction(hash: string): Promise<TransactionWithHeight>;
    lookupBlockHash(height: number): Promise<string>;
    lookupSyncStatus(): Promise<SyncStatus>;
    sendTransaction(hex: string): Promise<string>;

    // this creates ANOTHER socket!
    // this is for repeated checks after one failure
    hardStatusCheck(): Promise<boolean>;
};

// Types beginning with Bc - bitcore format
type BcDetailedInput = {
    address: ?string;
    outputIndex: ?number;
    prevTxId: ?string; // coinbase
    satoshis: number;
    script: string;
    scriptAsm: ?string;
    sequence: number;
}

type BcDetailedOutput = {
    address: ?string;
    satoshis: number;
    script: string;
    scriptAsm: string;
}

type BcDetailedTransaction = {
    blockTimestamp: ?number; // undef on unconfirmed
    feeSatoshis: number;
    hash: string;
    height: number; // -1 on unconfirmed
    hex: string;
    inputSatoshis: number;
    inputs: Array<BcDetailedInput>;
    locktime: number;
    outputSatoshis: number;
    outputs: Array<BcDetailedOutput>;
    version: number;
}

type BcSyncStatus = { height: number; };
type BcTransactionInfo = {
    tx: BcDetailedTransaction;
    confirmations: number; // 0 if no
    satoshis: number; // not sure what this means
};
type BcHistory = { addresses: { [address: string]: Object; }; } & BcTransactionInfo;
type BcHistories = { items: Array<BcHistory>; totalCount: number; };

type SocketWorkerFactory = () => Worker;

export class BitcoreBlockchain {
    errors: Stream<Error>; // socket errors
    reconnections: Stream<void>; // socket reconnections
    notifications: Stream<TransactionWithHeight>; // activity on subscribed addresses
    blocks: Stream<void>;

    addresses: Set<string>; // subscribed addresses
    socket: Deferred<Socket> = deferred();

    socketWorkerFactory: SocketWorkerFactory;
    endpoints: Array<string>;
    workingUrl: string = 'none';

    static _tryEndpoint(
        endpoints: Array<string>,
        socketWorkerFactory: SocketWorkerFactory,
        tried: {[k: string]: boolean}
    ): Promise<{socket: Socket, url: string}> {
        if (Object.keys(tried).length === endpoints.length + 1) {
            return Promise.reject(new Error('All backends are down.'));
        }
        let random = -1;
        while (tried[random.toString()]) {
            random = Math.floor(Math.random() * endpoints.length);
        }
        return onlineStatusCheck(socketWorkerFactory, endpoints[random]).then(socket => {
            if (socket) {
                return {socket, url: endpoints[random]};
            } else {
                tried[random.toString()] = true;
                return BitcoreBlockchain._tryEndpoint(endpoints, socketWorkerFactory, tried);
            }
        });
    }

    constructor(endpoints: Array<string>, socketWorkerFactory: SocketWorkerFactory) {
        this.addresses = new Set();

        this.socketWorkerFactory = socketWorkerFactory;
        this.endpoints = endpoints;

        const lookupTM = (socket: Socket): Stream<TransactionWithHeight> => {
            return socket.observe('bitcoind/addresstxid').mapPromise(
                ({txid}) =>
                    this.lookupTransaction(txid)
            );
        };
        const observeBlocks = (socket: Socket): Stream<void> => {
            socket.subscribe('bitcoind/hashblock');
            return socket.observe('bitcoind/hashblock');
        };

        const errors = Stream.setLater();
        const notifications = Stream.setLater();
        const blocks = Stream.setLater();
        this.errors = errors.stream;
        this.notifications = notifications.stream;
        this.blocks = blocks.stream;

        const tried = {'-1': true};
        BitcoreBlockchain._tryEndpoint(endpoints, socketWorkerFactory, tried).then(({socket, url}) => {
            this.workingUrl = url;
            this.socket.resolve(socket);
            errors.setter(observeErrors(socket));
            notifications.setter(lookupTM(socket));
            blocks.setter(observeBlocks(socket));
        }, () => {
            errors.setter(Stream.simple(new Error('All backends are offline.')));
            this.socket.reject(new Error('All backends are offline.'));
            this.socket.promise.catch((e) => console.error(e));
        });
    }

    // this creates ANOTHER socket!
    // this is for repeated checks after one failure
    hardStatusCheck(): Promise<boolean> {
        return Promise.all(this.endpoints.map(endpoint => onlineStatusCheck(this.socketWorkerFactory, endpoint)))
        .then((statuschecks) => {
            statuschecks.forEach(s => {
                if (s != null) {
                    s.close();
                }
            });
            const on = statuschecks.filter(i => i != null);
            return on.length > 0;
        });
    }

    subscribe(inAddresses: Set<string>) {
        this.socket.promise.then(socket => {
            const notMyAddresses = [...inAddresses].filter((a) => !(this.addresses.has(a)));
            notMyAddresses.forEach(a => this.addresses.add(a));
            if (notMyAddresses.length !== 0) {
                for (let i = 0; i < notMyAddresses.length; i += 20) {
                    socket.subscribe('bitcoind/addresstxid', notMyAddresses.slice(i, i + 20));
                }
            }
        }, () => {});
    }

    lookupTransactionsStream(
        addresses: Array<string>,
        start: number,
        end: number
    ): Stream<Array<TransactionWithHeight> | Error> {
        const res = Stream.fromPromise(
            this.socket.promise.then(socket => {
                return lookupAllAddressHistories(
                    socket,
                    addresses,
                    start,
                    end
                ).mapPromise((r) => {
                    if (r instanceof Error) {
                        return Promise.resolve(r);
                    }
                    return Promise.resolve(r.items.map(item => ({
                        hex: item.tx.hex,
                        height: item.tx.height === -1 ? null : item.tx.height,
                        timestamp: item.tx.blockTimestamp,
                        hash: item.tx.hash,
                        inputAddresses: item.tx.inputs.map(input => input.address),
                        outputAddresses: item.tx.outputs.map(output => output.address),
                    })));
                });
            })
        );
        return res;
    }

    lookupTransactions(
        addresses: Array<string>,
        start: number,
        end: number
    ): Promise<Array<TransactionWithHeight>> {
        const maybeRes: Promise<Array<TransactionWithHeight> | Error> = this.lookupTransactionsStream(
            addresses,
            start,
            end
        ).reduce((
            previous: Array<TransactionWithHeight> | Error,
            current: Array<TransactionWithHeight> | Error
        ) => {
            if (previous instanceof Error) {
                return previous;
            }
            if (current instanceof Error) {
                return current;
            }
            return previous.concat(current);
        }, []);
        return maybeRes.then((maybeArray) => {
            if (maybeArray instanceof Error) {
                throw maybeArray;
            }
            return maybeArray;
        });
    }

    lookupTransaction(hash: string): Promise<TransactionWithHeight> {
        return this.socket.promise.then(socket =>
            lookupDetailedTransaction(socket, hash)
                .then((info: BcDetailedTransaction): TransactionWithHeight => ({
                    hex: info.hex,
                    height: info.height === -1 ? null : info.height,
                    timestamp: info.blockTimestamp,
                    hash: info.hash,
                    inputAddresses: info.inputs.map(input => input.address),
                    outputAddresses: info.outputs.map(output => output.address),
                }))
        );
    }

    sendTransaction(hex: string): Promise<string> {
        return this.socket.promise.then(socket =>
            sendTransaction(socket, hex)
        );
    }

    lookupBlockHash(height: number): Promise<string> {
        return this.socket.promise.then(socket =>
            lookupBlockHash(socket, height)
        );
    }

    lookupSyncStatus(): Promise<BcSyncStatus> {
        return this.socket.promise.then(socket =>
            lookupSyncStatus(socket)
        );
    }

}

function lookupAllAddressHistories(
    socket: Socket,
    addresses: Array<string>,
    start: number,
    end: number,
    pageLength: number = 50,
): Stream<(BcHistories & { from: number; to: number; }) | Error> {
    return Stream.combineFlat([
        lookupAddressHistoriesMempool(socket, addresses, true, start, end),
        lookupAddressHistoriesMempool(socket, addresses, false, start, end),
    ]);
}

function lookupAddressHistoriesMempool(
    socket: Socket,
    addresses: Array<string>,
    mempool: boolean,
    start: number,
    end: number,
    pageLength: number = 50,
): Stream<(BcHistories & { from: number; to: number; }) | Error> {
    const initial = {
        from: 0,
        to: 0,
        items: [],
        totalCount: pageLength,
    };
    return Stream.generate(
        initial,
        (previous) => {
            if (previous instanceof Error) {
                return Promise.resolve(previous);
            }
            const from = previous.to;
            const to = Math.min(
                previous.to + pageLength,
                previous.totalCount
            );
            return lookupAddressHistories(
                socket,
                addresses,
                from,
                to,
                mempool,
                start,
                end
            ).then((result) => ({
                ...result,
                from,
                to,
            }), (error: mixed) => {
                if (typeof error === 'object' && error != null && error instanceof Error) {
                    return error;
                } else {
                    if (typeof error === 'string') {
                        return new Error(error);
                    } else {
                        return new Error(JSON.stringify(error));
                    }
                }
            });
        },
        (state: (BcHistories & { from: number; to: number; }) | Error) => {
            if (state instanceof Error) {
                return false;
            }
            return state.to < state.totalCount;
        }
    );
}

function lookupAddressHistories(
    socket: Socket,
    addresses: Array<string>,
    from: number,   // pagination from index (inclusive)
    to: number,     // pagination to index (not inclusive)
    mempool: boolean,
    start: number, // recent block height (inclusive)
    end: number    // older block height (inclusive)
): Promise<BcHistories> {
    const method = 'getAddressHistory';
    const rangeParam = mempool ? {
        start, // needed for older bitcores (so we don't load all history if bitcore-node < 3.1.3)
        end,
        queryMempoolOnly: true,
    } : {
        start,
        end,
        queryMempol: false,
    };
    const params = [
        addresses,
        {
            ...rangeParam,
            from,
            to,
        },
    ];
    return socket.send({ method, params });
}

// https://github.com/bitpay/bitcore-node/issues/423
function lookupDetailedTransaction(socket: Socket, hash: string): Promise<Object> {
    const method = 'getDetailedTransaction';
    const params = [
        hash,
    ];
    return socket.send({ method, params });
}

function sendTransaction(socket: Socket, hex: string): Promise<string> {
    const method = 'sendTransaction';
    const params = [
        hex,
    ];
    return socket.send({ method, params });
}

function lookupBlockHash(socket: Socket, height: number): Promise<string> {
    const method = 'getBlockHeader';
    const params = [height];
    return socket.send({method, params}).then(res => res.hash);
}

function lookupSyncStatus(socket: Socket): Promise<BcSyncStatus> {
    const method = 'getInfo';
    const params = [];
    return socket.send({method, params}).then(res => { return {height: res.blocks}; });
}

function onlineStatusCheck(socketWorkerFactory: SocketWorkerFactory, endpoint: string): Promise<?Socket> {
    const socket = new Socket(socketWorkerFactory, endpoint);
    const conn = new Promise((resolve) => {
        observeErrors(socket).awaitFirst().then(() => resolve(false)).catch(() => resolve(false));
        // we try to get the first block
        // if it returns something that looks like a blockhash, it probably works
        Promise.race([
            new Promise((resolve, reject) => setTimeout(() => reject(), 30000)),
            lookupBlockHash(socket, 0),
        ]).then(res => {
            if (res == null || res.length === 0) {
                resolve(false);
            } else {
                resolve(true);
            }
        }).catch(e => resolve(false));
    });
    return conn.then((res) => {
        if (!res) {
            socket.close();
            return null;
        }
        return socket;
    });
}

function observeErrors(socket: Socket): Stream<Error> {
    const errortypes = ['connect_error', 'reconnect_error', 'error', 'close', 'disconnect'];

    const s = Stream.combineFlat(errortypes.map(type =>
        socket.observe(type).map((k: mixed) => {
            if (k == null) {
                return new Error(type);
            }
            if (typeof k === 'object' && k instanceof Error) {
                return k;
            }
            if (typeof k === 'object') {
                if (typeof k.type === 'string') {
                    return new Error(k.type + ' ' + JSON.stringify(k));
                }
                return new Error(type + ' ' + JSON.stringify(k));
            }
            return new Error(k);
        })
    ));
    return s;
}
