#!/usr/bin/env node

function writeJsonDocument(document, stream = process.stdout) {
  stream.write(`${JSON.stringify(document, null, 2)}\n`);
}

module.exports = {
  writeJsonDocument
};
