module.exports = function(api) {
  api.cache(true);
  const presets = [
    [
      '@vue/cli-plugin-babel/preset',
      { useBuiltIns: false }
    ],
    [
      '@babel/preset-env',
      { targets: { node: 'current' } }
    ]
  ];
  const env = { test: { presets: [['@babel/env', { targets: { node: 'current' } }]] } };

  const plugins = [];

  if (process.env.NODE_ENV === 'test') {
    plugins.push('transform-require-context');
  }

  return {
    presets,
    plugins,
    env
  };
};
