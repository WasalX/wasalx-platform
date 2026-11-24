package org.wasalx.keycloak;

import org.keycloak.Config;
import org.keycloak.email.EmailException;
import org.keycloak.email.EmailTemplateProvider;
import org.keycloak.email.freemarker.FreeMarkerEmailTemplateProvider;
import org.keycloak.email.freemarker.FreeMarkerEmailTemplateProviderFactory;
import org.keycloak.models.Constants;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.UserModel;
import org.keycloak.provider.EnvironmentDependentProviderFactory;

import java.util.Collection;

public final class PasswordResetEmailTemplateFactory extends FreeMarkerEmailTemplateProviderFactory
        implements EnvironmentDependentProviderFactory {
    @Override
    public boolean isSupported(Config.Scope config) {
        // Keep FreeMarker as the default when this image runs outside the fenced Compose stack.
        return System.getenv("WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST") != null;
    }

    @Override
    public String getId() {
        return "wasalx-fenced";
    }

    @Override
    public EmailTemplateProvider create(KeycloakSession session) {
        return new Template(session, "true".equals(System.getenv("WASALX_KEYCLOAK_PASSWORD_RESET_ENABLED")));
    }

    static class Template extends FreeMarkerEmailTemplateProvider {
        private final boolean passwordResetEnabled;

        Template(KeycloakSession session, boolean passwordResetEnabled) {
            super(session);
            this.passwordResetEnabled = passwordResetEnabled;
        }

        @Override
        public void sendPasswordReset(String link, long expirationInMinutes) throws EmailException {
            requirePasswordResetEnabled();
            super.sendPasswordReset(link, expirationInMinutes);
        }

        @Override
        public void sendExecuteActions(String link, long expirationInMinutes) throws EmailException {
            if (attributes.get(Constants.TEMPLATE_ATTR_REQUIRED_ACTIONS) instanceof Collection<?> actions
                    && actions.contains(UserModel.RequiredAction.UPDATE_PASSWORD.name())) {
                requirePasswordResetEnabled();
            }
            super.sendExecuteActions(link, expirationInMinutes);
        }

        private void requirePasswordResetEnabled() throws EmailException {
            if (!passwordResetEnabled) throw new EmailException("Password reset email is disabled");
        }
    }
}
