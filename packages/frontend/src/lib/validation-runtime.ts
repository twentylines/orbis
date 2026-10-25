import { configure } from 'arktype/config';

// Browser schemas are small; avoid compiling validators while the loading scene animates.
configure({ jitless: true });
