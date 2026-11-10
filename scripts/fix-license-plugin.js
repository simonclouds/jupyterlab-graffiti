const fs = require('fs');
const path = require('path');

const file = path.join(
  __dirname,
  '..',
  'node_modules',
  'license-webpack-plugin',
  'dist',
  'WebpackModuleFileIterator.js'
);
const source = fs.readFileSync(file, 'utf8');
const broken = "return filename.split('=')[1].trim();";
const fixed =
  "var provided = filename.split('=')[1];\n            return provided ? provided.trim() : null;";
if (source.includes(broken)) {
  fs.writeFileSync(file, source.replace(broken, fixed));
}
