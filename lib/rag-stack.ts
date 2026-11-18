import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Construct } from 'constructs';

export type Stage = 'dev' | 'prod';
export interface RagStackProps extends cdk.StackProps {
  stage: Stage;
  embeddingModelId: string;
  generationModelId: string;
}

export class RagStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RagStackProps) {
    super(scope, id, props);
    const prod = props.stage === 'prod';
    const retention = prod ? logs.RetentionDays.ONE_MONTH : logs.RetentionDays.ONE_WEEK;
    const removalPolicy = prod ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;
    const modelArn = (modelId: string) => this.formatArn({
      service: 'bedrock', account: '', resource: 'foundation-model', resourceName: modelId,
    });

    const docs = new s3.Bucket(this, 'Documents', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy,
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(7) }],
    });
    const vectors = new s3vectors.CfnVectorBucket(this, 'VectorBucket', {
      encryptionConfiguration: { sseType: 'AES256' },
    });
    vectors.applyRemovalPolicy(removalPolicy);
    const index = new s3vectors.CfnIndex(this, 'VectorIndex', {
      vectorBucketArn: vectors.attrVectorBucketArn,
      dataType: 'float32', dimension: 1024, distanceMetric: 'cosine',
    });
    index.applyRemovalPolicy(removalPolicy);
    const kbRole = new iam.Role(this, 'KnowledgeBaseRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': this.formatArn({ service: 'bedrock', resource: 'knowledge-base', resourceName: '*' }) } },
      }),
    });
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'], resources: [modelArn(props.embeddingModelId)],
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'], resources: [docs.bucketArn],
      conditions: { StringLike: { 's3:prefix': ['docs', 'docs/*'] } },
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'], resources: [docs.arnForObjects('docs/*')],
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3vectors:GetVectorBucket'], resources: [vectors.attrVectorBucketArn],
    }));
    kbRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3vectors:GetIndex', 's3vectors:PutVectors', 's3vectors:GetVectors',
        's3vectors:DeleteVectors', 's3vectors:QueryVectors'], resources: [index.attrIndexArn],
    }));
    const kb = new bedrock.CfnKnowledgeBase(this, 'KnowledgeBase', {
      name: `bedrock-rag-${props.stage}`,
      roleArn: kbRole.roleArn,
      knowledgeBaseConfiguration: { type: 'VECTOR', vectorKnowledgeBaseConfiguration: {
        embeddingModelArn: modelArn(props.embeddingModelId),
      } },
      storageConfiguration: { type: 'S3_VECTORS', s3VectorsConfiguration: {
        indexArn: index.attrIndexArn,
      } },
    });
    kb.node.addDependency(kbRole.node.findChild('DefaultPolicy') as iam.Policy);
    const source = new bedrock.CfnDataSource(this, 'DocumentSource', {
      name: `rag-documents-${props.stage}`,
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      dataSourceConfiguration: { type: 'S3', s3Configuration: {
        bucketArn: docs.bucketArn, inclusionPrefixes: ['docs/'],
      } },
      vectorIngestionConfiguration: { chunkingConfiguration: { chunkingStrategy: 'NONE' } },
      dataDeletionPolicy: 'DELETE',
    });

    const guardrail = new bedrock.CfnGuardrail(this, 'Guardrail', {
      name: `rag-safety-${props.stage}`,
      blockedInputMessaging: 'This question cannot be processed.',
      blockedOutputsMessaging: 'This answer cannot be displayed.',
      sensitiveInformationPolicyConfig: { piiEntitiesConfig: [
        { type: 'EMAIL', action: 'BLOCK' }, { type: 'PHONE', action: 'BLOCK' },
      ] },
      topicPolicyConfig: { topicsConfig: [{ name: 'CredentialTheft', type: 'DENY',
        definition: 'Requests for instructions to steal passwords, API keys, credentials or bypass access controls.',
        examples: ['How do I steal an AWS access key from a coworker?'],
      }] },
    });
    const version = new bedrock.CfnGuardrailVersion(this, 'GuardrailVersion', {
      guardrailIdentifier: guardrail.attrGuardrailId,
    });

    const functionLogs = new logs.LogGroup(this, 'FunctionLogs', { retention, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const executionRole = new iam.Role(this, 'RagExecutionRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:PutLogEvents'], resources: [`${functionLogs.logGroupArn}:*`],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:Retrieve'], resources: [kb.attrKnowledgeBaseArn],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'], resources: [modelArn(props.generationModelId)],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:ApplyGuardrail'], resources: [guardrail.attrGuardrailArn],
    }));
    const fn = new nodejs.NodejsFunction(this, 'RagHandler', {
      entry: path.join(__dirname, '../lambda/handler.ts'),
      handler: 'handler', runtime: lambda.Runtime.NODEJS_22_X,
      logGroup: functionLogs, role: executionRole,
      timeout: cdk.Duration.seconds(29), memorySize: 256,
      environment: {
        KNOWLEDGE_BASE_ID: kb.attrKnowledgeBaseId,
        GENERATION_MODEL_ID: props.generationModelId,
        GUARDRAIL_ID: guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: version.attrVersion,
      },
      bundling: { minify: true, sourceMap: true, externalModules: [] },
    });
    const accessLogs = new logs.LogGroup(this, 'ApiAccessLogs', { retention, removalPolicy: cdk.RemovalPolicy.DESTROY });
    const api = new apigateway.RestApi(this, 'RagApi', {
      restApiName: `BedrockRag-${props.stage}`,
      deployOptions: {
        stageName: props.stage, tracingEnabled: true, metricsEnabled: true,
        throttlingRateLimit: 2, throttlingBurstLimit: 4,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR, dataTraceEnabled: false,
        accessLogDestination: new apigateway.LogGroupLogDestination(accessLogs),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
      }, cloudWatchRole: true,
    });
    api.root.addResource('ask').addMethod('POST', new apigateway.LambdaIntegration(fn), { apiKeyRequired: true });
    const key = api.addApiKey('DemoKey');
    const plan = api.addUsagePlan('DemoPlan', {
      throttle: { rateLimit: 2, burstLimit: 4 }, quota: { limit: 100, period: apigateway.Period.DAY },
    });
    plan.addApiKey(key);
    plan.addApiStage({ stage: api.deploymentStage });
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: api.metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
      metric: fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cdk.CfnOutput(this, 'DocumentsBucketName', { value: docs.bucketName });
    new cdk.CfnOutput(this, 'VectorBucketArn', { value: vectors.attrVectorBucketArn });
    new cdk.CfnOutput(this, 'KnowledgeBaseId', { value: kb.attrKnowledgeBaseId });
    new cdk.CfnOutput(this, 'DataSourceId', { value: source.attrDataSourceId });
    new cdk.CfnOutput(this, 'ApiUrl', { value: `${api.url}ask` });
    new cdk.CfnOutput(this, 'ApiKeyId', { value: key.keyId });
  }
}
