# pkgsz

## 0.12.3

### Patch Changes

- fd08461: Fixed minimum nodejs engine version

## 0.12.2

### Patch Changes

- c73bab0: Package version cannot be number

## 0.12.1

### Patch Changes

- 03f0355: fixed crash when json and interactive options used together (because of no logger present)

## 0.12.0

### Minor Changes

- e8e6b35: added json output option

## 0.11.1

### Patch Changes

- 00af172: Removed node import code because we only need rollup one
  Started working on json output and tests

## 0.11.0

### Minor Changes

- dcff719: use rollup to check for default exports

## 0.10.1

### Patch Changes

- 1f3b9de: updated pkgbld to include prune fix

## 0.10.0

### Minor Changes

- 94bef74: Improve single export data formatting

## 0.9.0

### Minor Changes

- 0893e21: Remove legal comments when minifying

## 0.8.1

### Patch Changes

- 16d7db7: fixed empty subpath exports interactive mode
  fixed single dependency interactive mode

## 0.8.0

### Minor Changes

- 7057684: get all dependencies and not olny top level one

## 0.7.0

### Minor Changes

- 46d3767: more information about package subexports printed
  fixed use case with deep package subexports

## 0.6.0

### Minor Changes

- 8ae3794: improve multiple subpath exports handling (wip)

## 0.5.0

### Minor Changes

- 13c29cf: more accurate default export detection

## 0.4.0

### Minor Changes

- d0c56f5: added sourcemap explorer

## 0.3.0

### Minor Changes

- b3f28a8: added experimental interactive mode, import option changed to export

## 0.2.0

### Minor Changes

- 7e0906b: Removed dedup (it makes no difference)

## 0.1.2

### Patch Changes

- dbe5403: Fixes:
  - pkgbld invocation
  - package.json path resolution check
