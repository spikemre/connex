import '@vechain/connex-framework/dist/driver-interface'
import { blake2b256 } from 'thor-devkit'
import * as randomBytes from 'randombytes'
import * as W from './wallet'

const TOS_URL = 'https://tos.vecha.in:5678/'
const SPA_WALLET_URL = 'https://qianbin.github.io/sync-spa/#/'

/** sign request relayed by tos */
type RelayedRequest = {
    type: 'tx' | 'cert'
    gid?: string
    payload: {
        message: object
        options: object
    }
    nonce: string
}

/** sign response relayed by tos */
type RelayedResponse = {
    error?: string
    payload?: object
}


async function connectWallet(rid: string, walletUrl: string) {
    const rUrl = TOS_URL + rid
    try {
        const r = W.connectApp(rUrl)
        if (r) {
            return await r
        }
    } catch { /** */ }
    try {
        return W.connectSPA(rUrl, walletUrl)
    } catch {/** */ }

    throw new Error('unexpected')
}

async function submitRequest(reqId: string, json: string) {
    for (let i = 0; i < 3; i++) {
        try {
            return await fetch(TOS_URL + reqId, {
                method: 'POST',
                body: json,
                headers: new Headers({
                    'Content-Type': 'application/json'
                })
            })
        } catch {
            await new Promise(resolve => setTimeout(resolve, 2000))
        }
    }
    throw new Error('failed to submit request')
}

async function pollResponse(reqId: string, suffix: string, timeout: number) {
    let errCount = 0
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        try {
            const resp = await fetch(`${TOS_URL}${reqId}${suffix}?wait=1`)
            const text = await resp.text()
            if (text) {
                return text
            }
        } catch (err) {
            if (++errCount > 2) {
                throw new Error('failed fetch response')
            }
            await new Promise(resolve => setTimeout(resolve, 3000))
        }
    }
    throw new Error('timeout')
}

async function sign<T extends 'tx' | 'cert'>(
    type: T,
    msg: T extends 'tx' ? Connex.Vendor.TxMessage : Connex.Vendor.CertMessage,
    options: T extends 'tx' ? Connex.Driver.TxOptions : Connex.Driver.CertOptions,
    genesisId: string,
    spaWalletUrl: string
): Promise<T extends 'tx' ? Connex.Vendor.TxResponse : Connex.Vendor.CertResponse> {
    let onAccepted = options.onAccepted
    options = { ...options, onAccepted: undefined }
    try {
        const req: RelayedRequest = {
            type,
            gid: genesisId,
            payload: {
                message: msg,
                options: options
            },
            nonce: randomBytes(16).toString('hex')
        }
        const json = JSON.stringify(req)
        const rid = blake2b256(json).toString('hex')
        connectWallet(rid, spaWalletUrl).catch(() => {/* noop */ })

        await submitRequest(rid, json)

        onAccepted && void (async () => {
            try {
                await pollResponse(rid, '-accepted', 60 * 1000)
                onAccepted && onAccepted()
            } catch (err) {
                console.warn(err)
            }
        })()

        const respJson = await pollResponse(rid, '-resp', 2 * 60 * 1000)
        const resp: RelayedResponse = JSON.parse(respJson)
        if (resp.error) {
            throw new Error(resp.error)
        }
        return resp.payload as any
    } finally {
        onAccepted = undefined
    }
}

/**
 * create a instance of wallet buddy to help make signing requests to wallet app
 * @param genesisId the genesis id of requests binding to
 * @param spaWalletUrl customized spa wallet url, dev only
 */
export function create(
    genesisId: string,
    spaWalletUrl?: string
): Pick<Connex.Driver, 'signTx' | 'signCert'> {
    const walletUrl = spaWalletUrl || SPA_WALLET_URL
    return {
        signTx(msg: Connex.Vendor.TxMessage, options: Connex.Driver.TxOptions): Promise<Connex.Vendor.TxResponse> {
            return sign('tx', msg, options, genesisId, walletUrl)
        },
        signCert(msg: Connex.Vendor.CertMessage, options: Connex.Driver.CertOptions): Promise<Connex.Vendor.CertResponse> {
            return sign('cert', msg, options, genesisId, walletUrl)
        }
    }
}
