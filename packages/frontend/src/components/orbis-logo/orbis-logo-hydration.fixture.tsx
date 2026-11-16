import { renderToStaticMarkup } from 'react-dom/server';
import { OrbisLogo } from './orbis-logo';

const markup = renderToStaticMarkup(<OrbisLogo size={112} dots />);
const paths = [...markup.matchAll(/class="orbis-logo-dot-group" d="([^"]+)"/g)].map((match) => match[1]);
process.stdout.write(JSON.stringify(paths));
