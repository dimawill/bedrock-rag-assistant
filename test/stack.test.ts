import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { RagStack } from '../lib/rag-stack';

function synth(stage: 'dev' | 'prod') {
  const app = new cdk.App();
  return Template.fromStack(new RagStack(app, `BedrockRag-${stage}`, {
    stage, embeddingModelId: 'amazon.titan-embed-text-v2:0', generationModelId: 'amazon.nova-lite-v1:0',
  }));
}

describe('Bedrock RAG stack', () => {
  it('protects source data and uses an S3 vector index with matching embedding dimensions', () => {
    const template = synth('dev');
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: Match.objectLike({ ServerSideEncryptionConfiguration: Match.anyValue() }),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
        Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      })]) },
    });
    template.hasResourceProperties('AWS::S3Vectors::VectorBucket', { EncryptionConfiguration: { SseType: 'AES256' } });
    template.hasResourceProperties('AWS::S3Vectors::Index', {
      Dimension: 1024, DataType: 'float32', DistanceMetric: 'cosine',
    });
    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      StorageConfiguration: Match.objectLike({ Type: 'S3_VECTORS', S3VectorsConfiguration: Match.objectLike({ IndexArn: Match.anyValue() }) }),
      KnowledgeBaseConfiguration: Match.objectLike({ Type: 'VECTOR' }),
    });
    template.hasResourceProperties('AWS::Bedrock::DataSource', {
      DataSourceConfiguration: Match.objectLike({ Type: 'S3', S3Configuration: Match.objectLike({ InclusionPrefixes: ['docs/'] }) }),
      VectorIngestionConfiguration: { ChunkingConfiguration: { ChunkingStrategy: 'NONE' } },
    });
  });
  it('has a guarded, throttled API and bounded runtime permissions', () => {
    const template = synth('dev');
    template.hasResourceProperties('AWS::Bedrock::Guardrail', {
      SensitiveInformationPolicyConfig: Match.objectLike({ PiiEntitiesConfig: Match.arrayWith([Match.objectLike({ Type: 'EMAIL' })]) }),
      TopicPolicyConfig: Match.objectLike({ TopicsConfig: Match.arrayWith([Match.objectLike({ Type: 'DENY' })]) }),
    });
    template.resourceCountIs('AWS::Bedrock::GuardrailVersion', 1);
    template.hasResourceProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Timeout: 29 });
    template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'POST', ApiKeyRequired: true });
    template.hasResourceProperties('AWS::ApiGateway::UsagePlan', { Throttle: { RateLimit: 2, BurstLimit: 4 }, Quota: { Limit: 100, Period: 'DAY' } });
    template.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    template.resourceCountIs('AWS::Logs::LogGroup', 2);
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('bedrock:Retrieve');
    expect(policies).toContain('bedrock:ApplyGuardrail');
    expect(policies).toContain('s3vectors:QueryVectors');
    expect(policies).not.toContain('bedrock:*');
    expect(policies).not.toContain('s3:*');
  });
  it('retains production data and vector resources', () => {
    const template = synth('prod');
    for (const type of ['AWS::S3::Bucket', 'AWS::S3Vectors::VectorBucket', 'AWS::S3Vectors::Index']) {
      for (const resource of Object.values(template.findResources(type))) expect(resource.DeletionPolicy).toBe('Retain');
    }
  });
});
