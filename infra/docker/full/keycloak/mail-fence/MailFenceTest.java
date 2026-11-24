package org.wasalx.keycloak;

import org.keycloak.email.EmailException;
import org.keycloak.email.EmailSenderProvider;
import org.keycloak.models.Constants;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.UserModel;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

final class MailFenceTest {
    private static final String ALLOWED = "fixture_2718" + "@" + "example.test";

    public static void main(String[] args) throws Exception {
        testRecipients();
        testPasswordReset();
    }

    private static void testRecipients() throws Exception {
        var sent = new ArrayList<String>();
        EmailSenderProvider transport = new EmailSenderProvider() {
            public void send(Map<String, String> config, String address, String subject, String text, String html) {
                sent.add(address);
            }
            public void validate(Map<String, String> config) {}
            public void close() {}
        };
        expect(IllegalArgumentException.class, () -> AllowedEmailSenderFactory.parseRecipients(null));
        expect(IllegalArgumentException.class, () -> AllowedEmailSenderFactory.parseRecipients(""));
        var deny = new AllowedEmailSenderFactory.Sender(transport, AllowedEmailSenderFactory.parseRecipients("[]"));
        expect(EmailException.class, () -> deny.send(Map.of(), ALLOWED, "", "", ""));
        String allowedJson = "[\"" + ALLOWED.toUpperCase(Locale.ROOT) + "\"]";
        for (String invalid : List.of(" * ", "null", "{}", "[1]", "[\"*\"]", allowedJson + " true")) {
            expect(IllegalArgumentException.class, () -> AllowedEmailSenderFactory.parseRecipients(invalid));
        }
        Set<String> allowed = AllowedEmailSenderFactory.parseRecipients(allowedJson);
        var sender = new AllowedEmailSenderFactory.Sender(transport, allowed);
        expect(EmailException.class, () -> sender.send(Map.of(), "blocked" + ALLOWED, "", "", ""));
        expect(EmailException.class, () -> sender.send(Map.of(), ALLOWED + "," + ALLOWED, "", "", ""));
        UserModel changed = proxy(UserModel.class, "getEmail", "changed" + ALLOWED);
        expect(EmailException.class, () -> sender.send(Map.of(), changed, "", "", ""));
        check(sent.isEmpty(), "a denied recipient reached the transport");
        sender.send(Map.of(), ALLOWED.toUpperCase(Locale.ROOT), "", "", "");
        sender.send(Map.of(), proxy(UserModel.class, "getEmail", ALLOWED), "", "", "");
        var unrestricted = new AllowedEmailSenderFactory.Sender(transport, AllowedEmailSenderFactory.parseRecipients("*"));
        unrestricted.send(Map.of(), "Other" + ALLOWED, "", "", "");
        check(sent.equals(List.of(ALLOWED.toUpperCase(Locale.ROOT), ALLOWED, "Other" + ALLOWED)),
            "transport should receive the original approved or unrestricted addresses");
    }

    private static void testPasswordReset() throws Exception {
        var disabled = new RecordingTemplate(false);
        expect(EmailException.class, () -> disabled.sendPasswordReset("", 1));
        disabled.setAttribute(Constants.TEMPLATE_ATTR_REQUIRED_ACTIONS, List.of("VERIFY_EMAIL", "UPDATE_PASSWORD"));
        expect(EmailException.class, () -> disabled.sendExecuteActions("", 1));
        check(disabled.sent.isEmpty(), "password reset was sent with the switch off");
        disabled.setAttribute(Constants.TEMPLATE_ATTR_REQUIRED_ACTIONS, List.of("VERIFY_EMAIL"));
        disabled.sendExecuteActions("", 1);
        check(disabled.sent.equals(List.of("executeActionsSubject")), "other required actions must still work");

        var enabled = new RecordingTemplate(true);
        enabled.sendPasswordReset("", 1);
        enabled.setAttribute(Constants.TEMPLATE_ATTR_REQUIRED_ACTIONS, List.of("UPDATE_PASSWORD"));
        enabled.sendExecuteActions("", 1);
        check(enabled.sent.equals(List.of("passwordResetSubject", "executeActionsSubject")), "password reset was not enabled");
    }

    private static final class RecordingTemplate extends PasswordResetEmailTemplateFactory.Template {
        final List<String> sent = new ArrayList<>();

        RecordingTemplate(boolean enabled) {
            super(proxy(KeycloakSession.class, "getProvider", null), enabled);
        }

        @Override
        protected void addLinkInfoIntoAttributes(String link, long expiration, Map<String, Object> attributes) {}

        @Override
        public void send(String subject, String template, Map<String, Object> attributes) {
            sent.add(subject);
        }
    }

    private static <T> T proxy(Class<T> type, String methodName, Object result) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] {type}, (proxy, method, args) -> {
            check(method.getName().equals(methodName), "unexpected Keycloak method " + method.getName());
            return result;
        }));
    }

    @FunctionalInterface
    private interface Operation {
        void run() throws Exception;
    }

    private static void expect(Class<? extends Exception> type, Operation operation) throws Exception {
        try {
            operation.run();
        } catch (Exception error) {
            if (type.isInstance(error)) return;
            throw error;
        }
        throw new AssertionError("expected " + type.getSimpleName());
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
