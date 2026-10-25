import { type } from 'arktype';
import { dynamicComposeSchemaV1 } from './utils/converters/v1.js';
import { dynamicComposeSchemaArk, serviceSchemaArk } from './dynamic-compose-ark.js';
import { MIN_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION } from './dynamic-compose-version.js';

export { MIN_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION };

// V2 schemas (current)
export const serviceSchemaV2 = serviceSchemaArk;
export const dynamicComposeSchemaV2 = dynamicComposeSchemaArk;

// Union over supported schema versions
export const dynamicComposeUnion = type.or(dynamicComposeSchemaV1, dynamicComposeSchemaV2);

export const serviceSchema = serviceSchemaV2;
export const dynamicComposeSchema = dynamicComposeSchemaV2;

export type DynamicCompose = typeof dynamicComposeSchema.infer;
export type ServiceInput = typeof serviceSchema.inferIn;
export type Service = typeof serviceSchema.infer;
export type DependsOn = Service['dependsOn'];
