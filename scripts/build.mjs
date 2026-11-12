// Copies the single source of truth (apps-script/Core.js) into the static site.
import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../apps-script/Core.js', import.meta.url), new URL('../docs/core.js', import.meta.url));
console.log('docs/core.js updated from apps-script/Core.js');
