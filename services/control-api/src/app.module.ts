import { PortalWorkspaceController } from "./portal-workspace.controller.js";
import {MetaManagedApprovalService} from "./meta-managed-approval.service.js";
import { Module } from "@nestjs/common";
import { NativeRoutingSyncController } from "./native-routing-sync.controller.js";
import { NativeRoutingSyncService } from "./native-routing-sync.service.js";
import { NativeMembershipController, NativeMembershipInternalController } from "./native-membership.controller.js";
import { NativeMembershipService } from "./native-membership.service.js";
import { APP_GUARD } from "@nestjs/core";
import { AuditController } from "./audit.controller.js";
import { MetaCostController, PlatformMetaCostController } from "./meta-cost.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { ConnectionsController } from "./connections.controller.js";
import { DatabaseService } from "./database.service.js";
import { DeliveriesController } from "./deliveries.controller.js";
import { HealthController } from "./health.controller.js";
import { GroupsController } from "./groups.controller.js";
import { PermissionGuard } from "./permission.guard.js";
import { RulesController } from "./rules.controller.js";
import { RuleGovernanceService } from "./rule-governance.service.js";
import { RuleTestController } from "./rule-test.controller.js";
import { RuleTestService } from "./rule-test.service.js";
import { ServiceAuthService } from "./service-auth.service.js";
import { ZammadServiceSecretService } from "./zammad-service-secret.service.js";
import { TenantDrainService } from "./tenant-drain.service.js";
import { ZammadInternalController } from "./zammad-internal.controller.js";
import { ZammadTicketStateController } from "./zammad-ticket-state.controller.js";
import { CasesController } from "./cases.controller.js";
import { WebhookIngressController } from "./webhook-ingress.controller.js";
import { SessionController } from "./session.controller.js";
import { WebhookSecretService } from "./webhook-secret.service.js";
import { SecretProvisioningService } from "./secret-provisioning.service.js";
import { TenantHealthController } from "./tenant-health.controller.js";
import { SecretCleanupRepository } from "./secret-cleanup.repository.js";
import { SecretCleanupService } from "./secret-cleanup.service.js";
import { WahaAdminSecretService } from "./waha-admin-secret.service.js";
import { WahaAuthorizationClientFactory } from "./waha-authorization.client.js";
import { WahaAuthorizationController } from "./waha-authorization.controller.js";
import { WahaAuthorizationService } from "./waha-authorization.service.js";
import {
  PlatformOperatorAuthService,
  PlatformOperatorGuard,
} from "./platform-operator-auth.js";
import { TenantProvisioningController } from "./tenant-provisioning.controller.js";
import { HttpTenantProvisioningDriver } from "./tenant-provisioning.driver.js";
import { TenantProvisioningRepository } from "./tenant-provisioning.repository.js";
import { TenantProvisioningService } from "./tenant-provisioning.service.js";
import { TenantProvisioningWorker } from "./tenant-provisioning.worker.js";
import { MetaCredentialService } from "./meta-credential.service.js";
import { MetaGroupsClientFactory } from "./meta-groups.client.js";
import { MetaGroupsController } from "./meta-groups.controller.js";
import { MetaGroupsService } from "./meta-groups.service.js";
import { MetaRoutingController,PlatformMetaRoutingController,MetaThreadControlController } from "./meta-routing.controller.js";
import { MetaRoutingService } from "./meta-routing.service.js";
import { MetaThreadControlService } from "./meta-thread-control.service.js";
import { PrivacyArtifactService } from "./privacy-artifact.service.js";
import { PrivacyController } from "./privacy.controller.js";
import { InvitationTokenService } from "./invitation-token.service.js";
import { TenantAdministrationController } from "./tenant-administration.controller.js";
import { QuarantineController } from "./quarantine.controller.js";
import {
  PlatformSupportAccessController,
  TenantSupportAccessController,
} from "./support-access.controller.js";
import { SupportAccessRepository } from "./support-access.repository.js";
import { SupportAccessService } from "./support-access.service.js";
import { WahaWorkersController } from "./waha-workers.controller.js";
import { WahaWorkersService } from "./waha-workers.service.js";
import {
  MeteringIngestController,
  PlatformMeteringController,
  PlatformOperationsController,
} from "./platform-operations.controller.js";
import { PlatformOperationsRepository } from "./platform-operations.repository.js";
import { PlatformOperationsService } from "./platform-operations.service.js";
import { MeteringAuthService } from "./metering-auth.service.js";
import { MeteringRepository } from "./metering.repository.js";
import { MeteringService } from "./metering.service.js";
import { MeteringReconcilerService } from "./metering-reconciler.service.js";
import { ZammadRoutingCatalogController } from "./zammad-routing-catalog.controller.js";
import { ZammadRoutingCatalogService } from "./zammad-routing-catalog.service.js";
import { PlatformWahaOutboundSafetyController, TenantWahaOutboundSafetyController } from "./waha-outbound-safety.controller.js";
import { WahaOutboundSafetyService } from "./waha-outbound-safety.service.js";
import { BotFlowsController } from "./bot-flows.controller.js";
import { BotFlowsService } from "./bot-flows.service.js";
import { RoutingConnectorsConfig } from "./routing-connectors.config.js";
import { GroupWorkspaceController, ZammadGroupWorkspaceController } from "./group-workspace.controller.js";
import { MetaSignupService } from "./meta-signup.service.js";
import { MetaDeletionCallbackController, MetaDeletionReviewController } from "./meta-deletion.controller.js";
import { MetaDeletionService } from "./meta-deletion.service.js";
import { MetaCoexistenceController } from "./meta-coexistence.controller.js";
@Module({controllers:[PortalWorkspaceController,NativeRoutingSyncController,MetaDeletionCallbackController,MetaDeletionReviewController,MetaCostController,PlatformMetaCostController,MetaRoutingController,PlatformMetaRoutingController,MetaThreadControlController,MetaCoexistenceController,NativeMembershipController,NativeMembershipInternalController,BotFlowsController,HealthController,TenantHealthController,SessionController,ConnectionsController,WahaAuthorizationController,MetaGroupsController,GroupsController,GroupWorkspaceController,ZammadGroupWorkspaceController,ZammadRoutingCatalogController,RulesController,RuleTestController,CasesController,DeliveriesController,QuarantineController,AuditController,PrivacyController,TenantAdministrationController,TenantSupportAccessController,TenantWahaOutboundSafetyController,ZammadInternalController,ZammadTicketStateController,WebhookIngressController,TenantProvisioningController,PlatformSupportAccessController,WahaWorkersController,PlatformWahaOutboundSafetyController,PlatformOperationsController,PlatformMeteringController,MeteringIngestController],providers:[PortalWorkspaceController,NativeRoutingSyncService,MetaDeletionService,MetaManagedApprovalService,MetaRoutingService,MetaThreadControlService,MetaSignupService,NativeMembershipService,BotFlowsService,RoutingConnectorsConfig,DatabaseService,AuthService,ZammadServiceSecretService,ZammadRoutingCatalogService,ServiceAuthService,TenantDrainService,WebhookSecretService,SecretProvisioningService,SecretCleanupRepository,SecretCleanupService,WahaAdminSecretService,WahaAuthorizationClientFactory,WahaAuthorizationService,MetaCredentialService,MetaGroupsClientFactory,MetaGroupsService,PrivacyArtifactService,RuleTestService,RuleGovernanceService,InvitationTokenService,SupportAccessRepository,SupportAccessService,WahaWorkersService,WahaOutboundSafetyService,PlatformOperatorAuthService,PlatformOperatorGuard,TenantProvisioningRepository,HttpTenantProvisioningDriver,TenantProvisioningWorker,TenantProvisioningService,PlatformOperationsRepository,PlatformOperationsService,MeteringAuthService,MeteringRepository,MeteringService,MeteringReconcilerService,{provide:APP_GUARD,useClass:AuthGuard},{provide:APP_GUARD,useClass:PermissionGuard}]})
export class AppModule{}
