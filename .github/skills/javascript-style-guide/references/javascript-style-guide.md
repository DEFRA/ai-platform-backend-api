---
layout: default
title: JavaScript Style Guide
---

# JavaScript Style Guide

This page outlines the style guide / coding conventions for JavaScript code within the Defra AICE team.

This guide is an extension to the [Defra JavaScript Standards](https://defra.github.io/software-development-standards/standards/javascript_standards/) and is intended to be used in conjunction with it.

## Table of Contents

- [1 JavaScript Project Rules](#1-javascript-project-rules)
  - [1.1 Linting / Formatting](#11-linting--formatting)
  - [1.2 Module System](#12-module-system)
    - [1.2.1 Imports](#121-imports)
    - [1.2.2 Exports](#122-exports)
  - [1.3 Testing](#13-testing)
    - [1.3.1 Mocking](#131-mocking)
  - [1.4 Dependency Management](#14-dependency-management)
    - [1.4.1 .npmrc Configuration](#141-npmrc-configuration)
    - [1.4.2 Security Scanning](#142-security-scanning)
  - [1.5 Documentation](#15-documentation)
- [2 JavaScript Style Guide](#2-javascript-style-guide)
  - [2.1 Source Files](#21-source-files)
    - [2.1.1 File Naming](#211-file-naming)
    - [2.1.2 Formatting](#212-formatting)
    - [2.1.3 Indentation](#213-indentation)
    - [2.1.4 Semicolons](#214-semicolons)
    - [2.1.5 Line Length Limit](#215-line-length-limit)
  - [2.2 Variable Declarations](#22-variable-declarations)
  - [2.3 Functions](#23-functions)
    - [2.3.1 Function Declarations](#231-function-declarations)
    - [2.3.2 Function Expressions](#232-function-expressions)
    - [2.3.3 Parameters](#233-parameters)
    - [2.3.4 Object Method Definition](#234-object-method-definition)
  - [2.4 Strings](#24-strings)
    - [2.4.1 String Literals](#241-string-literals)
    - [2.4.2 Template Literals](#242-template-literals)
  - [2.5 Classes](#25-classes)
- [Contributions](#contributions)

## 1 JavaScript Project Rules

### 1.1 Linting / Formatting
The Defra JavaScript Standards enforces using ESLint using only [neostandard](https://github.com/neostandard/neostandard) as the only linter of choice. Therefore, all AICE JavaScript code should follow the neostandard rules.

All ESLint rules enabled in neostandard by default can be found [here](https://eslint.style/rules), however, key rules are highlighted below.

### 1.2 Module System
The AICE team uses ES modules for JavaScript code. Each module should be defined in its own file, and the file name should match the module name.

#### 1.2.1 Imports
All module imports should use ES `import` syntax and not CommonJS `require` syntax. The import statements should be placed at the top of the file, before any other code.

All imports should be at the top of the file, and they should be grouped in the following order alphabetically:
1. External libraries
2. Internal modules

Do this:
```javascript
import Hapi from '@hapi/hapi'

import myModule from './my-module.js'
```

Don't do this:
```javascript
const Hapi = require('@hapi/hapi')

const myModule = require('./my-module.js')
```

#### 1.2.2 Exports
All module exports should use ES `export` syntax and not CommonJS `module.exports`. The export statements should be placed at the bottom of the file, after all other code.

Always use named exports, default exports are not allowed.

Do this:
```javascript
function myFunction() {
  // function code
}

export { 
  myFunction 
}
```

Don't do this:
```javascript
export default function myFunction() {
  // function code
}

// or this
module.exports = function myFunction() {
  // function code
}
```

### 1.3 Testing
We use [Vitest](https://vitest.dev/) for testing JavaScript code. All tests should be placed in a dedicated `tests` directory at the root of the project. Each test file should be named after the module it tests, with a `.test.js` suffix.

Test files should not be placed in the same directory as the module under test.

#### 1.3.1 Mocking
When mocking dependencies in tests, if not using dependency injection, you should use the `vi.mock()` function provided by Vitest. You should not use any other mocking library such as `sinon` or `jest.mock()`.

You should also only mock dependencies that the team owns or has control over. If a dependency is an external library, you should not mock it unless absolutely necessary. In these cases, you should consider using a integration test instead of a unit test.

### 1.4 Dependency Management
All project dependencies must be managed using the `package.json` file. Use `npm` commands to add, update, or remove dependencies to ensure that the `package.json` file is kept up to date.

Ensure that you pin dependencies to specific versions to avoid unexpected issues due to version changes. Do not use range specifiers (`^`, `~`, etc.) and only pin to exact versions.

```jsonc
// Do this
{
  "name": "my_project",
  "version": "0.1.0",
  "dependencies": {
    "@hapi/hapi": "4.17.1",
    "eslint": "3.20.2"
  }
}

// Not this
{
  "name": "my_project",
  "version": "0.1.0",
  "dependencies": {
    "@hapi/hapi": "^4.17.1",
    "eslint": "^3.20.2"
  }
}
```

#### 1.4.1 .npmrc Configuration
All projects must include an `.npmrc` file at the root of the project with the following configuration:
```
save-exact=true
ignore-scripts=true
```

`save-exact=true` ensures that all dependencies are pinned to exact versions when added to the `package.json` file.
`ignore-scripts=true` prevents the execution of lifecycle scripts when running npm commands. Lifecycle scripts have been exploited in recent supply chain attacks, so this setting helps to mitigate that risk.

#### 1.4.2 Security Scanning
All projects must regularly run `npm audit` and preferably other security scanning tools to identify and flag any known vulnerabilities in project dependencies and source code. Any vulnerabilities found should be addressed promptly by updating or replacing the affected dependencies.

These audits should also be automated as part of our CI pipelines and nightly scheduled scans. See the following GitHub actions for an example of how to set this up:
- [scan.yml](https://github.com/DEFRA/ai-defra-search-frontend/blob/main/.github/workflows/scan.yml)
- [check-pull-request.yml](https://github.com/DEFRA/ai-defra-search-frontend/blob/main/.github/workflows/check-pull-request.yml)
- [publish.yml](https://github.com/DEFRA/ai-defra-search-frontend/blob/main/.github/workflows/publish.yml)

### 1.5 Documentation
All functions, classes, and modules should be documented using JSDoc comments. However, you should take a pragmatic approach to using JSDocs. Only document what is necessary to understand the code, and avoid over-documenting.

For example, when creating a function or a class, you should document:
- The purpose of the function or class
- The parameters it takes, including their types and descriptions
- The return value, including its type and description
- Any exceptions that may be thrown

You must avoid writing overly verbose comments that do not add value or are self-explanatory from the code itself. The goal is to make the code more understandable, not to repeat what is already clear.

Likewise, you should also avoid using JSDocs to document owners or versioning information, as this information is not relevant to the code itself and can be easily tracked using version control systems like Git.

Do this:
```javascript
/**
 * Adds two numbers together.
 *
 * @param {number} a - The first number.
 * @param {number} b - The second number.
 * @returns {number} The sum of the two numbers.
 */
function add(a, b) {
  return a + b
}
```

Don't do this:
```javascript
/**
 * This function adds two numbers together.
 * It takes two parameters, a and b, which are both numbers.
 * It returns the sum of the two numbers.
 * 
 * @author John Doe
 * @version 1.0
 * @since 2023-10-01
 * @param {number} a - The first number.
 * @param {number} b - The second number.
 * @returns {number} The sum of the two numbers.
 */
function add(a, b) {
  return a + b
}
```

## 2 JavaScript Style Guide

### 2.1 Source Files

#### 2.1.1 File Naming

All source files should be UTF-8 encoded and have a `.js` extension. The file name must also be in kebab-case, which is a lower-case name with words separated by hyphens. For example, `my-awesome-file.js`.

The file name should be descriptive of the module's purpose and functionality. Avoid using abbreviations or acronyms unless they are widely recognised.

For example, a good file name for a server module might be `server.js`, while a bad file name might be `s.js` or `initialise.js`.

#### 2.1.2 Formatting

#### 2.1.3 Indentation
All code blocks should be indented with 2 spaces. Tabs are not allowed.

#### 2.1.4 Semicolons
No semicolons should be used at the end of statements.

Do this:
```javascript
function myFunction() {
  console.log('Hello, world!')
}
```

Don't do this:
```javascript
function myFunction() {
  console.log('Hello, world!');
}
```

#### 2.1.5 Line Length Limit
The maximum line length is 80 characters. Lines should be wrapped or refactored to fit within this limit.

### 2.2 Variable Declarations

All variables should be declared using `const` by default. If a variable needs to be reassigned, use `let`. Using var is not allowed.

Do this:
```javascript
const myVariable = 'Hello, world!'

// or this
let myVariable

myVariable = 'Hello, world!'
```

Don't do this:
```javascript
var myVariable = 'Hello, world!'
```

### 2.3 Functions

### 2.4 Strings

### 2.5 Classes

## Contributions
If you would like to contribute to this style guide, please open a pull request on the [Defra AICE Team GitHub](https://github.com/DEFRA/aice-team) repository.

For anything that is not covered by this style guide, we recommend following the [Defra JavaScript Standards](https://defra.github.io/software-development-standards/standards/javascript_standards/) and staying consistent with the existing codebase. If alignment across AICE is required, please raise an issue in [Defra AICE Team GitHub](https://github.com/DEFRA/aice-team/issues).
