'use strict';

const _ = require('lodash');
const BbPromise = require('bluebird');
const Api = require('kubernetes-client');
const fs = require('fs');
const helpers = require('../lib/helpers');
const JSZip = require('jszip');
const path = require('path');

class KubelessDeploy {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options || {};
    this.provider = this.serverless.getProvider('google');

    this.hooks = {
      'deploy:deploy': () => BbPromise.bind(this)
        .then(this.validate)
        .then(this.deployFunction),
    };
  }

  validate() {
    helpers.validateEnv();
    const unsupportedOptions = ['stage', 'region'];
    helpers.warnUnsupportedOptions(
      unsupportedOptions,
      this.options,
      this.serverless.cli.log.bind(this.serverless.cli)
    );
    return BbPromise.resolve();
  }

  getFunctionContent(handlerRelativePath) {
    const pkg = this.options.package ||
      this.serverless.service.package.path;
    let resultPromise = null;
    if (pkg) {
      resultPromise = JSZip.loadAsync(fs.readFileSync(pkg)).then(
        (zip) => zip.file(handlerRelativePath).async('string')
      );
    } else {
      resultPromise = new BbPromise(resolve => {
        fs.readFile(
          path.join(this.serverless.config.servicePath || '.', handlerRelativePath),
          (err, d) => resolve(d.toString()));
      });
    }
    return resultPromise;
  }

  deployFunction() {
    const thirdPartyResources = new Api.ThirdPartyResources(
      Object.assign(helpers.getMinikubeCredentials(), {
        url: process.env.KUBE_API_URL,
        group: 'k8s.io',
      })
    );
    thirdPartyResources.addResource('functions');
    const errors = [];
    let counter = 0;
    return new BbPromise((resolve, reject) => {
      _.each(this.serverless.service.functions, (description, name) => {
        this.getFunctionContent(
          `${description.handler.toString().split('.')[0]}.py`
        ).then(functionContent => {
          const funcs = {
            apiVersion: 'k8s.io/v1',
            kind: 'Function',
            metadata: {
              name,
              namespace: 'default',
            },
            spec: {
              deps: '',
              function: functionContent,
              handler: description.handler,
              runtime: this.serverless.service.provider.runtime,
              topic: '',
              type: 'HTTP',
            },
          };
          // Create function
          thirdPartyResources.ns.functions.post({ body: funcs }, (err) => {
            if (err) {
              if (err.code === 409) {
                this.serverless.cli.log(
                  `The function ${name} is already deployed. ` +
                  'Remove it if you want to deploy it again.'
                );
              } else {
                errors.push(
                  `Unable to deploy the function ${name}. Received:\n` +
                  `  Code: ${err.code}\n` +
                  `  Message: ${err.message}`
                );
              }
            } else {
              this.serverless.cli.log(
                `Function ${name} succesfully deployed`
              );
            }
            counter++;
            if (counter === _.keys(this.serverless.service.functions).length) {
              if (_.isEmpty(errors)) {
                resolve();
              } else {
                reject(
                  `Found errors while deploying the given functions:\n${errors.join('\n')}`
                );
              }
            }
          });
        });
      });
    });
  }
}

module.exports = KubelessDeploy;
