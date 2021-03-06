import * as _ from 'lodash';
import * as path from 'path';
import * as fs from 'fs';
import * as tmp from 'tmp';

import { expect } from 'chai';

import { getLocal, generateCACertificate, Mockttp } from 'mockttp';

import { buildInterceptors, Interceptor } from '../../src/interceptors';

const getCertificateDetails = _.memoize((configPath: string) => {
    const keyPath = path.join(configPath, 'ca.key');
    const certPath = path.join(configPath, 'ca.pem');

    const newCertPair = generateCACertificate({ commonName: 'HTTP Toolkit CA - DO NOT TRUST' });

    fs.writeFileSync(keyPath, newCertPair.key);
    fs.writeFileSync(certPath, newCertPair.cert);

    return { certPath, keyPath };
});

export function getInterceptorAndServer(interceptor: string): { server: Mockttp, interceptor: Interceptor } {
    const configPath = tmp.dirSync({ unsafeCleanup: true }).name;

    const { certPath, keyPath } = getCertificateDetails(configPath);

    const server = getLocal({ https: { certPath, keyPath } });
    const interceptors = buildInterceptors({ configPath, https: { certPath, keyPath } });

    return { server, interceptor: interceptors[interceptor] };
}

// Various tests that we'll want to reuse across interceptors:

export function itIsAvailable(interceptor: Interceptor) {
    it('is available', async () => {
        expect(await interceptor.isActivable()).to.equal(true);
    });
}

export function itCanBeActivated(interceptor: Interceptor, server: Mockttp) {
    it('can be activated', async () => {
        expect(interceptor.isActive(server.port)).to.equal(false);

        await interceptor.activate(server.port);
        expect(interceptor.isActive(server.port)).to.equal(true);
        expect(interceptor.isActive(server.port + 1)).to.equal(false);

        await interceptor.deactivate(server.port);
        expect(interceptor.isActive(server.port)).to.equal(false);
    });
}