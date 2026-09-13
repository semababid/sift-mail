import { MongoMemoryServer } from 'mongodb-memory-server';

// One mongod for the whole run, on the same major version as the Docker image,
// so the suite does not depend on Docker Desktop being up. Each test file then
// gets its own database on it, so files can run side by side without dropping
// each other's collections.
export default async function setup(project) {
  const mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } });
  project.provide('mongoUri', mongod.getUri());

  return async () => {
    await mongod.stop();
  };
}
