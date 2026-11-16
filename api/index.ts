import path from 'node:path';
import { createApiApp } from '../server/app.ts';

const rootDir = process.cwd();
const app = createApiApp(path.resolve(rootDir));

export default app;
