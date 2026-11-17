import type { FastifyAdapter } from "@nestjs/platform-fastify";

// Meta's retained PHP example reads signed_request from POST form fields.
// Current public Markdown does not specify a universal HTTP media type;
// this bounded URL-encoded parser remains an explicit DEV wire prerequisite.
export function registerMetaDeletionForm(adapter: FastifyAdapter) {
  // Use Nest's public registration path so later init keeps its JSON/raw-body
  // parser and does not attempt to register the form parser a second time.
  adapter.registerParserMiddleware(undefined, true);
  const instance = adapter.getInstance();
  instance.removeContentTypeParser("application/x-www-form-urlencoded");
  instance.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 8192 }, (_request, body, done) => done(null, body));
}
