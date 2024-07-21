# Package Size (pkgsz)

[![npm version](https://img.shields.io/npm/v/pkgsz.svg?style=flat-square)](https://www.npmjs.com/package/pkgsz)

Get the size of an npm package.

## Usage

```bash
npx pkgsz [flags] <package name> [version]
```

## Features

- Uses rollup to build the package
- Reports the statistics regarding node_modules size and minified / gzipped size (brotli compression is optional)
- Supports subpath exports
- Able to include json files
- Supports custom registries

## Limitations

- If you are using something like angular size will be incorrect because this tool does not include the angular compiler (or any other UI framework / library compiler)
- Only reports sizes in binary units (Kib, Mib, bytes)
- Installs using `npm install` and not `yarn` / `pnpm` / `bun` etc.

## Options

### -b, --brotli

Calculate brotli compressed size

### -c, --no-clean

Do not clean the temporary directory

### -d, --dedup

Deduplicate files (using prefer-dedupe flag)

### -g, --no-gzip

Do not calculate gzipped size

### -i, --import

Import a subpath from the package (default: ["."])

### -r, --registry

The npm registry to use when installing the package

### -s, --enable-scripts

Enable scripts

### -h, --help

Show help

### --version

Show version

# License

[MIT](https://github.com/kshutkin/package-size/blob/main/LICENSE)