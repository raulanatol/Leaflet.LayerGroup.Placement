#!/usr/bin/env bash

set -eu

rm -Rf dist
mkdir -p dist
cp src/index.js dist/index.js
