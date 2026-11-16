const node = Bun.which('node');
if (!node) throw new Error('Node is required to check logo hydration.');
const bundle = await Bun.build({
  entrypoints: [new URL('./orbis-logo-hydration.fixture.tsx', import.meta.url).pathname],
  target: 'node',
  plugins: [
    {
      name: 'render-without-styles',
      setup(build) {
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
      },
    },
  ],
});
if (!bundle.success) throw new Error('The logo check could not be bundled.');
const script = await bundle.outputs[0]?.text();
if (!script) throw new Error('The logo check has no output.');
const outputs = await Promise.all(
  [
    [process.execPath, 'run', '-'],
    [node, '--input-type=module', '-'],
  ].map(async (command) => {
    const child = Bun.spawn(command, { stdin: new Blob([script]), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0 || stderr) throw new Error('A logo rendering process did not complete.');
    return { groups: JSON.parse(stdout).length, sha256: new Bun.CryptoHasher('sha256').update(stdout).digest('hex') };
  }),
);
process.stdout.write(JSON.stringify(outputs));
