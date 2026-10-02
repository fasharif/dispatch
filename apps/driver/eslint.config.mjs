import expoConfig from 'eslint-config-expo/flat.js';

const config = [...expoConfig, { ignores: ['.expo/**', 'android/**', 'ios/**'] }];

export default config;
