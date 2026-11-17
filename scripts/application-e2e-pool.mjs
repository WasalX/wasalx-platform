// Fixture locale lanes own disjoint role servers and state directories.
export function validateRoleSuites(locales, roles, basePort, isolatedFixtures = true) {
  if (!roles.length || new Set(roles).size !== roles.length || !locales.length || new Set(locales).size !== locales.length)
    throw new Error("Application E2E roles and locales must be unique");
  const portCount = roles.length * (isolatedFixtures ? locales.length : 1);
  if (!Number.isSafeInteger(basePort) || basePort < 1024 || basePort + portCount - 1 > 65535)
    throw new Error("Application E2E fixture ports are invalid");
}

export async function runRoleSuites(locales, roles, basePort, run, isolatedFixtures = true) {
  validateRoleSuites(locales, roles, basePort, isolatedFixtures);
  const errors = [];
  let nextLocale = 0;
  const localeWorker = async () => {
    while (nextLocale < locales.length) {
      const localeIndex = nextLocale++;
      const locale = locales[localeIndex];
      let next = 0;
      const worker = async () => {
        while (next < roles.length) {
          const index = next++;
          const port = basePort + (isolatedFixtures ? localeIndex * roles.length : 0) + index;
          try { await run(locale, roles[index], port); }
          catch (error) { errors.push(error); }
        }
      };
      // Real platform sessions retain the original serial execution.
      await Promise.all(Array.from({ length: Math.min(isolatedFixtures ? 2 : 1, roles.length) }, worker));
    }
  };
  await Promise.all(Array.from({ length: Math.min(isolatedFixtures ? 2 : 1, locales.length) }, localeWorker));
  if (errors.length) throw new AggregateError(errors, "Application E2E role launches failed");
}
