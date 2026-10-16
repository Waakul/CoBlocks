const commonGlobals = {
    console: 'readonly',
    setInterval: 'readonly',
    clearInterval: 'readonly',
    setTimeout: 'readonly',
    clearTimeout: 'readonly',
    URL: 'readonly',
};

const browserGlobals = {
    ...commonGlobals,
    alert: 'readonly',
    chrome: 'readonly',
    confirm: 'readonly',
    crypto: 'readonly',
    document: 'readonly',
    Element: 'readonly',
    fetch: 'readonly',
    getComputedStyle: 'readonly',
    location: 'readonly',
    MutationObserver: 'readonly',
    navigator: 'readonly',
    requestAnimationFrame: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    URLSearchParams: 'readonly',
    window: 'readonly',
};

const sharedRules = {
    'array-bracket-spacing': ['error', 'never'],
    'arrow-spacing': 'error',
    'block-spacing': 'error',
    'brace-style': ['error', '1tbs', { allowSingleLine: true }],
    'comma-dangle': ['error', 'always-multiline'],
    'comma-spacing': ['error', { before: false, after: true }],
    'computed-property-spacing': ['error', 'never'],
    'eol-last': ['error', 'always'],
    'eqeqeq': ['error', 'always', { null: 'ignore' }],
    'func-call-spacing': ['error', 'never'],
    'indent': ['error', 4, { SwitchCase: 1 }],
    'key-spacing': ['error', { beforeColon: false, afterColon: true }],
    'keyword-spacing': 'error',
    'no-console': 'off',
    'no-multi-spaces': 'error',
    'no-trailing-spaces': 'error',
    'no-var': 'error',
    'object-curly-spacing': ['error', 'always'],
    'prefer-const': 'error',
    'quotes': ['error', 'single', { avoidEscape: true }],
    'semi': ['error', 'always'],
    'space-before-blocks': 'error',
    'space-infix-ops': 'error',
    'space-unary-ops': 'error',
};

export default [
    {
        ignores: [
            '**/node_modules/**',
            'backend/storage*/**',
            'extension/background/socket.io.js',
        ],
    },
    {
        files: ['backend/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: {
                ...commonGlobals,
                AbortSignal: 'readonly',
                Buffer: 'readonly',
                fetch: 'readonly',
                global: 'readonly',
                process: 'readonly',
            },
        },
        rules: {
            ...sharedRules,
            'no-undef': 'error',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['backend/**/*.cjs'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: {
                ...commonGlobals,
                module: 'readonly',
                process: 'readonly',
                require: 'readonly',
            },
        },
        rules: {
            ...sharedRules,
            'no-undef': 'error',
            'no-unused-vars': 'error',
        },
    },
    {
        files: ['extension/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            globals: browserGlobals,
        },
        rules: sharedRules,
    },
    {
        files: [
            'extension/background.js',
            'extension/background/**/*.js',
            'extension/auth/**/*.js',
            'extension/injectors/**/*.js',
            'extension/popups/**/*.js',
            'extension/projects/**/*.js',
            'extension/scripts/badge.js',
        ],
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
        },
    },
    {
        files: ['extension/background.js', 'extension/background/**/*.js'],
        languageOptions: {
            globals: {
                ...browserGlobals,
                AbortSignal: 'readonly',
                apiUrl: 'writable',
                authenticatedFetch: 'readonly',
                clearRejectedCredentials: 'readonly',
                currentCoBlocksToken: 'writable',
                getCurrentCoBlocksTokenAfterUsernameRefresh: 'readonly',
                importScripts: 'readonly',
                indexedDB: 'readonly',
                io: 'readonly',
                COBLOCKS: 'writable',
                logoutCoBlocks: 'readonly',
                self: 'readonly',
                uname: 'writable',
            },
        },
    },
];
