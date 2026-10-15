import { type } from 'arktype';
import { createArkDto } from 'nestjs-arktype';

const streamAppQuerySchema = type({
  appUrn: type('string > 2 & string <= 180').narrow((value) => /^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+$/.test(value)),
  'maxLines?': type('number.integer | string.integer.parse').to('1 <= number <= 1000'),
});

const streamRuntipiQuerySchema = type({
  'maxLines?': type('number.integer | string.integer.parse').to('1 <= number <= 1000'),
});

export class StreamAppLogsQueryDto extends createArkDto(streamAppQuerySchema, { name: 'StreamAppLogsQueryDto', input: true }) {}
export class StreamRuntipiLogsQueryDto extends createArkDto(streamRuntipiQuerySchema, { name: 'StreamRuntipiLogsQueryDto', input: true }) {}
