module.exports = {
  hooks: {
    readPackage(pkg) {
      // This workspace intentionally uses React 18 for the web and React 19 for
      // Expo/RN. Libraries that publish React declarations but omit the types
      // peer otherwise resolve the shared hidden-hoisted @types/react (which can
      // be the other app's version), causing incompatible Context/JSX types.
      // An optional peer makes pnpm bind declarations to each consumer's own
      // installed types. It neither changes React versions nor forces types onto
      // non-React packages. Preserve existing peer ranges and metadata exactly.
      // An explicitly present peer (even an empty range) or dangling metadata
      // belongs to the publisher. Do not overwrite either with our default.
      if (pkg.peerDependencies?.react
        && !Object.hasOwn(pkg.peerDependencies, '@types/react')
        && !Object.hasOwn(pkg.peerDependenciesMeta ?? {}, '@types/react')) {
        pkg.peerDependencies = { ...pkg.peerDependencies, '@types/react': '*' };
        pkg.peerDependenciesMeta = { ...pkg.peerDependenciesMeta, '@types/react': { optional: true } };
      }
      return pkg;
    }
  }
};
