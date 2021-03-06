import { promisify } from 'util';
import * as fs from 'fs';
import * as _ from 'lodash';
import * as rimraf from 'rimraf';
import * as path from 'path';

import { HtkConfig } from '../config';

import { getAvailableBrowsers, launchBrowser, BrowserInstance } from '../browsers';
import { CertCheckServer } from '../cert-check-server';
import { delay } from '../util';
import { Interceptor } from '.';

const deleteFolder = promisify(rimraf);
const readFile = promisify(fs.readFile);
const canAccess = (path: string) =>
    new Promise((resolve) => {
        fs.access(path, (error: Error | null) => resolve(!error));
    });

const FIREFOX_PREF_REGEX = /\w+_pref\("([^"]+)", (.*)\);/

let browsers: _.Dictionary<BrowserInstance> = {};

export class FreshFirefox implements Interceptor {
    id = 'fresh-firefox';
    version = '1.0.0';

    constructor(private config: HtkConfig) { }

    isActive(proxyPort: number) {
        return browsers[proxyPort] != null && !!browsers[proxyPort].pid;
    }

    async isActivable() {
        const availableBrowsers = await getAvailableBrowsers(this.config.configPath);

        return _(availableBrowsers)
            .map(b => b.name)
            .includes('firefox')

    }

    async activate(proxyPort: number) {
        if (this.isActive(proxyPort)) return;

        const certCheckServer = new CertCheckServer(this.config);
        await certCheckServer.start('https://amiusing.httptoolkit.tech');

        const firefoxProfile = path.join(this.config.configPath, 'firefox-profile');

        let existingPrefs: _.Dictionary<any> = {}

        if (await canAccess(firefoxProfile)) {
            // If the profile exists, then we've run this before and not deleted the profile,
            // so it probably worked. If so, reuse the existing preferences to avoids issues
            // where on pref setup firefox behaves badly (opening a 2nd window) on OSX.
            const prefContents = await readFile(path.join(firefoxProfile, 'prefs.js'), {
                encoding: 'utf8'
            });

            existingPrefs = _(prefContents)
                .split('\n')
                .reduce((prefs: _.Dictionary<any>, line) => {
                    const match = FIREFOX_PREF_REGEX.exec(line);
                    if (match) {
                        prefs[match[1]] = match[2];
                    }
                    return prefs
                }, {});
        }

        const browser = await launchBrowser(certCheckServer.checkCertUrl, {
            browser: 'firefox',
            profile: firefoxProfile,
            proxy: `localhost:${proxyPort}`,
            // Don't intercept our cert testing requests
            noProxy: certCheckServer.host,
            prefs: _.assign(existingPrefs, {
                // By default james-launcher only configures HTTP, so we need to add HTTPS:
                'network.proxy.ssl': '"localhost"',
                'network.proxy.ssl_port': proxyPort,

                // The above james proxy/noProxy settings should do this, but don't seem to
                // reliably overwrite existing values, so we set them explicitly.
                'network.proxy.http': '"localhost"',
                'network.proxy.http_port': proxyPort,
                'network.proxy.http.network.proxy.http.no_proxies_on': certCheckServer.host,

                // Disable the noisy captive portal check requests
                'network.captive-portal-service.enabled': false,

                // Disable some annoying tip messages
                'browser.chrome.toolbar_tips': false,

                // Ignore available updates:
                "app.update.auto": false,
                "browser.startup.homepage_override.mstone": "ignore",

                // Disable exit warnings:
                "browser.showQuitWarning": false,
                "browser.tabs.warnOnClose": false,
                "browser.tabs.warnOnCloseOtherTabs": false,

                // Disable various first-run things:
                "browser.uitour.enabled": false,
                'browser.usedOnWindows10': true,
                "browser.usedOnWindows10.introURL": "",
                'datareporting.healthreport.service.firstRun': false,
                'toolkit.telemetry.reportingpolicy.firstRun': false,
                'browser.reader.detectedFirstArticle': false,
                "datareporting.policy.dataSubmissionEnabled": false,
                "datareporting.policy.dataSubmissionPolicyAccepted": false,
                "datareporting.policy.dataSubmissionPolicyBypassNotification": true
            })
        }, this.config.configPath);

        let success = false;
        certCheckServer.waitForSuccess().then(() => {
            success = true;
        }).catch(console.warn);

        browsers[proxyPort] = browser;
        browser.process.once('exit', () => {
            certCheckServer.stop();
            delete browsers[proxyPort];
            if (!success) {
                deleteFolder(firefoxProfile).catch(console.warn);
            }
        });

        // Delay the approx amount of time it normally takes Firefox to really open
        await delay(1000);
    }

    async deactivate(proxyPort: number) {
        if (this.isActive(proxyPort)) {
            const browser = browsers[proxyPort];
            const exitPromise = new Promise((resolve) => browser!.process.once('exit', resolve));
            browser!.stop();
            await exitPromise;
        }
    }
};