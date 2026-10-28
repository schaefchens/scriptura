// Bundles books with the app, so the reader adds them natively: their text never passes through
// JS, nor is it in the JS bundle. In app.json:
//
//   "plugins": [["@schaefchens/scriptura-react-native", { "books": ["./texts/books.json"] }]]
//
// and in the app, addBooks({ asset: 'books.json' }). They go into a folder named scriptura-books: just
// scriptura would, on a case-insensitive file system, be the executable of an app called Scriptura.
const fs = require('node:fs');
const path = require('node:path');
// From the app first: a package linked from elsewhere resolves from where it really is.
const { IOSConfig, withDangerousMod, withXcodeProject } = require(require.resolve('expo/config-plugins', { paths: [process.cwd(), __dirname] }));

const FOLDER = 'scriptura-books';

function copyBooks(books, projectRoot, directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const file of books) fs.copyFileSync(path.resolve(projectRoot, file), path.join(directory, path.basename(file)));
}

module.exports = function withScriptura(config, { books = [] } = {}) {
  config = withDangerousMod(config, [
    'android',
    (config) => {
      const assets = path.join(config.modRequest.platformProjectRoot, 'app/src/main/assets', FOLDER);
      copyBooks(books, config.modRequest.projectRoot, assets);
      return config;
    },
  ]);
  return withXcodeProject(config, (config) => {
    const { projectName, platformProjectRoot, projectRoot } = config.modRequest;
    copyBooks(books, projectRoot, path.join(platformProjectRoot, projectName, FOLDER));
    // A folder reference in the app's group, so the books land in the bundle as scriptura-books/<file>.
    const project = config.modResults;
    const group = IOSConfig.XcodeUtils.ensureGroupRecursively(project, projectName);
    const groups = project.hash.project.objects.PBXGroup;
    const key = Object.keys(groups).find((candidate) => groups[candidate] === group);
    project.addResourceFile(`${projectName}/${FOLDER}`, { lastKnownFileType: 'folder' }, key);
    return config;
  });
};
