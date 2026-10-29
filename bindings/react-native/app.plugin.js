// Bundles books with the app, so the reader adds them natively: their text never passes through
// JS, nor is it in the JS bundle. In app.json:
//
//   "plugins": [["@schaefchens/scriptura-react-native", { "books": ["./texts/books.json"], "recordings": ["./recordings"] }]]
//
// and in the app, addBooks({ asset: 'books.json' }). They go into a folder named scriptura-books: just
// scriptura would, on a case-insensitive file system, be the executable of an app called Scriptura.
// Recordings come as folders, with their audio, into scriptura-recordings: addRecordings({ asset:
// 'recordings.json' }) finds the audio there.
const fs = require('node:fs');
const path = require('node:path');
// From the app first: a package linked from elsewhere resolves from where it really is.
const { IOSConfig, withDangerousMod, withXcodeProject } = require(require.resolve('expo/config-plugins', { paths: [process.cwd(), __dirname] }));

const BOOKS = 'scriptura-books';
const RECORDINGS = 'scriptura-recordings';

function copy(books, recordings, projectRoot, directory) {
  fs.mkdirSync(path.join(directory, BOOKS), { recursive: true });
  for (const file of books) fs.copyFileSync(path.resolve(projectRoot, file), path.join(directory, BOOKS, path.basename(file)));
  for (const folder of recordings) fs.cpSync(path.resolve(projectRoot, folder), path.join(directory, RECORDINGS), { recursive: true });
}

module.exports = function withScriptura(config, { books = [], recordings = [] } = {}) {
  config = withDangerousMod(config, [
    'android',
    (config) => {
      copy(books, recordings, config.modRequest.projectRoot, path.join(config.modRequest.platformProjectRoot, 'app/src/main/assets'));
      return config;
    },
  ]);
  return withXcodeProject(config, (config) => {
    const { projectName, platformProjectRoot, projectRoot } = config.modRequest;
    copy(books, recordings, projectRoot, path.join(platformProjectRoot, projectName));
    // Folder references in the app's group, so they land in the bundle as scriptura-books/<file>.
    const project = config.modResults;
    const group = IOSConfig.XcodeUtils.ensureGroupRecursively(project, projectName);
    const groups = project.hash.project.objects.PBXGroup;
    const key = Object.keys(groups).find((candidate) => groups[candidate] === group);
    for (const folder of recordings.length > 0 ? [BOOKS, RECORDINGS] : [BOOKS]) {
      if (!project.hasFile(`${projectName}/${folder}`)) project.addResourceFile(`${projectName}/${folder}`, { lastKnownFileType: 'folder' }, key);
    }
    return config;
  });
};
