import {createRequire} from 'node:module';
import {resolve} from 'node:path';

// Frozen drivers run outside node_modules; resolve from the admitted candidate cwd.
const ts=createRequire(resolve('package.json'))('typescript');

export function relativeModuleDependencies(source) {
 return ts.preProcessFile(source,true,true).importedFiles.map(file=>file.fileName).filter(path=>path.startsWith('.'));
}
