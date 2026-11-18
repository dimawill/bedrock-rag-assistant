#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RagStack, type Stage } from '../lib/rag-stack';

const app = new cdk.App();
const stage = app.node.tryGetContext('stage') as string;
if (stage !== 'dev' && stage !== 'prod') throw new Error('Set -c stage=dev or -c stage=prod');
const embeddingModelId = app.node.tryGetContext('embeddingModelId') as string;
const generationModelId = app.node.tryGetContext('generationModelId') as string;
if (!embeddingModelId || !generationModelId) throw new Error('Set embeddingModelId and generationModelId in CDK context');
new RagStack(app, `BedrockRag-${stage}`, {
  stage: stage as Stage,
  embeddingModelId,
  generationModelId,
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
