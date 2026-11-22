import * as Sentry from '@sentry/nestjs';
import {
  cleanseErrorData,
  isRecoveryKeyHandoffBreadcrumb,
  isRecoveryKeyHandoffEvent,
  isRecoveryKeyHandoffPath,
} from './common/helpers/error-helpers';

const { NODE_ENV, TIPI_VERSION } = process.env;

const isKeyHandoffRequest = () => isRecoveryKeyHandoffPath(Sentry.getIsolationScope().getScopeData().sdkProcessingMetadata.normalizedRequest?.url);

Sentry.init({
  release: TIPI_VERSION,
  enabled: false,
  tracesSampleRate: 1.0,
  dsn: 'https://6cc88df40d1cdd0222ff30d996ca457c@o4504242900238336.ingest.us.sentry.io/4508264534835200',
  environment: NODE_ENV,
  beforeSend: (event, hint) => (isKeyHandoffRequest() ? null : cleanseErrorData(event, hint)),
  beforeSendTransaction: (event) => (isKeyHandoffRequest() || isRecoveryKeyHandoffEvent(event) ? null : event),
  beforeBreadcrumb: (breadcrumb) => (isKeyHandoffRequest() || isRecoveryKeyHandoffBreadcrumb(breadcrumb) ? null : breadcrumb),
  includeLocalVariables: true,
  integrations: [
    Sentry.extraErrorDataIntegration(),
    Sentry.nestIntegration(),
    Sentry.httpIntegration({
      ignoreIncomingRequests: isRecoveryKeyHandoffPath,
      ignoreIncomingRequestBody: isRecoveryKeyHandoffPath,
      ignoreOutgoingRequests: isRecoveryKeyHandoffPath,
    }),
  ],
  initialScope: {
    tags: { version: TIPI_VERSION },
  },
});
