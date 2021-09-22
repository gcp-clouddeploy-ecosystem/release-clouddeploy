/*
 * Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as toolCache from '@actions/tool-cache';
import * as setupGcloud from './setup-google-cloud-sdk/src';
import path from 'path';

export const GCLOUD_METRICS_ENV_VAR = 'CLOUDSDK_METRICS_ENVIRONMENT';
export const GCLOUD_METRICS_LABEL = 'github-actions-deploy-cloudrun';

/**
 * Executes the main action. It includes the main business logic and is the
 * primary entry point. It is documented inline.
 */
export async function run(): Promise<void> {
  core.exportVariable(GCLOUD_METRICS_ENV_VAR, GCLOUD_METRICS_LABEL);
  try {
    // Get inputs
    // Core inputs
    const credentials = core.getInput('credentials'); // Service account key
    let projectId = core.getInput('project_id');
    let gcloudVersion = core.getInput('gcloud_version');
    // Flags
    const release = core.getInput('release');
    const deliveryPipeline = core.getInput('delivery_pipeline');
    const region = core.getInput('region') || 'us-central1';
    const annotations = core.getInput('annotations');
    const labels = core.getInput('labels');
    const description = core.getInput('description');
    const gcsSourceStagingDir = core.getInput('gcs_source_staging_dir');
    const ignoreFile = core.getInput('ignore_file');
    const toTarget = core.getInput('to_target');
    const buildArtifacts = core.getInput('build_artifacts');
    const source = core.getInput('source');
    const images = core.getInput('images');
    const flags = core.getInput('flags');

    // Flag for installing gcloud beta components
    // Currently, the deploy command is only supported in the beta command
    const installBeta = true;
    let cmd;

    cmd = [
      'deploy',
      'release',
      'create',
      release,
      '--quiet',
      '--region',
      region,
      '--delivery-pipeline',
      deliveryPipeline,
    ];

    // Add optional flags
    if (flags) {
      const flagList = parseFlags(flags);
      if (flagList) cmd = cmd.concat(flagList);
    }

    if (annotations) {
      cmd = cmd.concat(['--annotations', annotations]);
    }

    if (labels) {
      cmd = cmd.concat(['--labels', labels]);
    }

    if (description) {
      cmd = cmd.concat(['--description', description]);
    }

    if (gcsSourceStagingDir) {
      cmd = cmd.concat(['--gcs-source-staging-dir', gcsSourceStagingDir]);
    }

    if (ignoreFile) {
      cmd = cmd.concat(['--ignore-file', ignoreFile]);
    }

    if (source) {
      cmd = cmd.concat(['--source', source]);
    }

    if (toTarget) {
      cmd = cmd.concat(['--to-target', toTarget]);
    }

    if (images) {
      cmd = cmd.concat(['--images', images]);
    }

    if (buildArtifacts) {
      cmd = cmd.concat(['--buildArtifacts', buildArtifacts]);
    }

    // Install gcloud if not already installed.
    if (!gcloudVersion || gcloudVersion == 'latest') {
      gcloudVersion = await setupGcloud.getLatestGcloudSDKVersion();
    }
    if (!setupGcloud.isInstalled(gcloudVersion)) {
      await setupGcloud.installGcloudSDK(gcloudVersion);
    } else {
      const toolPath = toolCache.find('gcloud', gcloudVersion);
      core.addPath(path.join(toolPath, 'bin'));
    }

    // Authenticate gcloud SDK.
    if (credentials) await setupGcloud.authenticateGcloudSDK(credentials);
    const authenticated = await setupGcloud.isAuthenticated();
    if (!authenticated) {
      throw new Error('Error authenticating the Cloud SDK.');
    }

    // set PROJECT ID
    if (projectId) {
      await setupGcloud.setProject(projectId);
    } else if (credentials) {
      projectId = await setupGcloud.setProjectWithKey(credentials);
    } else if (process.env.GCLOUD_PROJECT) {
      await setupGcloud.setProject(process.env.GCLOUD_PROJECT);
    }
    // Fail if no Project Id is provided if not already set.
    const projectIdSet = await setupGcloud.isProjectIdSet();
    if (!projectIdSet)
      throw new Error(
        'No project Id provided. Ensure you have set either the project_id or credentials fields.',
      );

    // Install beta components if needed and prepend the beta command
    if (installBeta) {
      await setupGcloud.installComponent('beta');
      cmd.unshift('beta');
    }

    const toolCommand = setupGcloud.getToolCommand();

    // Get output of gcloud cmd.
    let output = '';
    const stdout = (data: Buffer): void => {
      output += data.toString();
    };
    let errOutput = '';
    const stderr = (data: Buffer): void => {
      errOutput += data.toString();
    };

    const options = {
      listeners: {
        stderr,
        stdout,
      },
      silent: true,
    };
    core.info(`running: ${toolCommand} ${cmd.join(' ')}`);
    // Run gcloud cmd.
    try {
      await exec.exec(toolCommand, cmd, options);
      // Set url as output.
      setUrlOutput(output + errOutput);
      core.setOutput('release', release);
    } catch (err: any) {
      if (errOutput) {
        throw new Error(errOutput);
      } else {
        throw new Error(err);
      }
    }
  } catch (err: any) {
    core.setFailed(err.message);
  }
}

export function setUrlOutput(output: string): string | undefined {
  // regex to match Cloud Run URLs
  const urlMatch = output.match(/Waiting for operation [(.*)]...done./g);
  if (!urlMatch) {
    core.warning('Can not find URL.');
    return undefined;
  }
  // Match operation ID
  const operationId = urlMatch!.length > 1 ? urlMatch![1] : urlMatch![0];
  core.setOutput('operation_id', operationId);
  return operationId;
}

export function parseFlags(flags: string): RegExpMatchArray {
  return flags.match(/(".*?"|[^"\s=]+)+(?=\s*|\s*$)/g)!; // Split on space or "=" if not in quotes
}
