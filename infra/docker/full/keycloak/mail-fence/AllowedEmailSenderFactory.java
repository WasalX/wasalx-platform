package org.wasalx.keycloak;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import org.keycloak.Config;
import org.keycloak.email.DefaultEmailSenderProviderFactory;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailSenderProvider;
import org.keycloak.models.KeycloakSession;
import org.keycloak.util.JsonSerialization;

import java.io.IOException;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

public final class AllowedEmailSenderFactory extends DefaultEmailSenderProviderFactory {
    private static final String ALLOWLIST = "WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST";
    private static final Pattern ADDRESS = Pattern.compile(
        "[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*"
        + "@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+");
    private Set<String> recipients = Set.of();

    @Override
    public String getId() {
        return "wasalx-fenced";
    }

    @Override
    public void init(Config.Scope config) {
        recipients = parseRecipients(System.getenv(ALLOWLIST));
        super.init(config);
    }

    @Override
    public EmailSenderProvider create(KeycloakSession session) {
        return new Sender(super.create(session), recipients);
    }

    static Set<String> parseRecipients(String raw) {
        if (raw == null || raw.isBlank()) throw new IllegalArgumentException(ALLOWLIST + " is required");
        if (raw.equals("*")) return null;
        JsonNode values;
        try {
            values = JsonSerialization.mapper.readerFor(JsonNode.class)
                .with(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readValue(raw);
        } catch (IOException error) {
            throw new IllegalArgumentException(ALLOWLIST + " must be a JSON array of email addresses");
        }
        if (values == null || !values.isArray()) {
            throw new IllegalArgumentException(ALLOWLIST + " must be a JSON array of email addresses");
        }
        Set<String> allowed = new HashSet<>();
        for (int index = 0; index < values.size(); index++) {
            String address = values.get(index).textValue();
            String email = address == null ? "" : address.strip().toLowerCase(Locale.ROOT);
            if (email.length() > 320 || !ADDRESS.matcher(email).matches()) {
                throw new IllegalArgumentException(ALLOWLIST + "[" + index + "] must be an email address");
            }
            allowed.add(email);
        }
        return Set.copyOf(allowed);
    }

    record Sender(EmailSenderProvider delegate, Set<String> recipients) implements EmailSenderProvider {
        @Override
        public void send(Map<String, String> config, String address, String subject, String text, String html)
                throws EmailException {
            String recipient = address == null ? "" : address.strip().toLowerCase(Locale.ROOT);
            if (recipients != null && !recipients.contains(recipient)) {
                throw new EmailException("Recipient is outside the test email allowlist");
            }
            delegate.send(config, address, subject, text, html);
        }

        @Override
        public void validate(Map<String, String> config) throws EmailException {
            delegate.validate(config);
        }

        @Override
        public void close() {
            delegate.close();
        }
    }
}
