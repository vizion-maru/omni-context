import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const isProduction = !process.argv.includes('--dev');
const DIST = 'dist';
const EXT = 'extension';

const VENDOR_FILES = [
  'lib/ExtPay.esm.js',
  'lib/ExtPay.iife.js',
  'lib/pdf.min.mjs',
  'lib/pdf.worker.min.mjs',
  'lib/marked.min.js',
  'lib/highlight.core.min.js',
  'lib/hljs-javascript.min.js',
  'lib/hljs-json.min.js',
  'lib/hljs-python.min.js',
  'lib/mermaid.min.js',
  'lib/highlight-monokai.css',
];

const STATIC_DIRS = ['_locales', 'icons', 'styles'];
const STATIC_FILES = [
  'manifest.json',
  'sidepanel.html',
  'options.html',
  'oauth-callback.html',
  'theme-init.js',
];

const externalizeVendor = {
  name: 'externalize-vendor',
  setup(build) {
    build.onResolve({ filter: /ExtPay\.esm\.js$|pdf\.min\.mjs$/ }, (args) => ({
      path: './lib/' + args.path.replace(/^\.\//, ''),
      external: true,
    }));
  },
};

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

await esbuild.build({
  entryPoints: [`${EXT}/background.js`, `${EXT}/sidepanel.js`, `${EXT}/options.js`],
  outdir: DIST,
  outbase: EXT,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120'],
  minify: isProduction,
  sourcemap: !isProduction,
  plugins: [externalizeVendor],
});

await esbuild.build({
  entryPoints: [`${EXT}/content.js`],
  outdir: DIST,
  outbase: EXT,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: isProduction,
  sourcemap: !isProduction,
});

mkdirSync(`${DIST}/lib`, { recursive: true });
for (const file of VENDOR_FILES) {
  cpSync(`${EXT}/${file}`, `${DIST}/${file}`);
}

for (const dir of STATIC_DIRS) {
  cpSync(`${EXT}/${dir}`, `${DIST}/${dir}`, { recursive: true });
}

for (const file of STATIC_FILES) {
  cpSync(`${EXT}/${file}`, `${DIST}/${file}`);
}

const mode = isProduction ? 'production' : 'development';
console.log(`Build complete (${mode}) → ${DIST}/`);
