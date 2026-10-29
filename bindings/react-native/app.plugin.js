// Bundles books with the app, so the reader adds them natively: their text never passes through
// JS, nor is it in the JS bundle. In app.json:
//
//   "plugins": [["@schaefchens/scriptura-react-native", { "books": ["./texts/books.json"], "recordings": ["./recordings"] }]]
//
// and in the app, addBooks({ asset: 'books.json' }). They go into a folder named scriptura-books: just
// scriptura would, on a case-insensitive file system, be the executable of an app called Scriptura.
// Recordings come as folders, with their audio, into scriptura-recordings: addRecordings({ asset:
// 'recordings.json' }) finds the audio there.
//
// With "backgroundAudio": true, a reader with something to show in the system's media controls
// (its nowPlaying) reads on in the background: iOS gets the audio background mode, Android the
// media service that keeps the app going and the permissions it needs.
const fs = require('node:fs');
const path = require('node:path');
// From the app first: a package linked from elsewhere resolves from where it really is.
const { AndroidConfig, IOSConfig, withAndroidManifest, withDangerousMod, withInfoPlist, withXcodeProject } = require(
  require.resolve('expo/config-plugins', { paths: [process.cwd(), __dirname] }),
);

const BOOKS = 'scriptura-books';
const RECORDINGS = 'scriptura-recordings';

function copy(books, recordings, projectRoot, directory) {
  fs.mkdirSync(path.join(directory, BOOKS), { recursive: true });
  for (const file of books) fs.copyFileSync(path.resolve(projectRoot, file), path.join(directory, BOOKS, path.basename(file)));
  for (const folder of recordings) fs.cpSync(path.resolve(projectRoot, folder), path.join(directory, RECORDINGS), { recursive: true });
}

/** The audio background mode on iOS; on Android, the media service and its permissions. */
function withBackgroundAudio(config) {
  config = withInfoPlist(config, (config) => {
    const modes = config.modResults.UIBackgroundModes ?? [];
    if (!modes.includes('audio')) config.modResults.UIBackgroundModes = [...modes, 'audio'];
    return config;
  });
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    AndroidConfig.Permissions.ensurePermissions(manifest, ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK']);
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    const name = 'de.schaefchens.scriptura.ReadingService';
    application.service = (application.service ?? []).filter((service) => service.$['android:name'] !== name);
    application.service.push({
      $: { 'android:name': name, 'android:exported': 'true', 'android:foregroundServiceType': 'mediaPlayback' },
      'intent-filter': [{ action: [{ $: { 'android:name': 'androidx.media3.session.MediaSessionService' } }] }],
    });
    return config;
  });
}

module.exports = function withScriptura(config, { books = [], recordings = [], backgroundAudio = false } = {}) {
  if (backgroundAudio) config = withBackgroundAudio(config);
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
