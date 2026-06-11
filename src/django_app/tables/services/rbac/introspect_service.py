"""Token-introspect helpers.

``resolve_can_edit`` is the single place that computes whether a user may
edit a flow inside an org.  It is intentionally free-standing (no singleton,
no state) so the view can call it inline without coupling to a specific auth
context.

Rules (per the EST-11 acceptance criteria):
  1. Security gate: the flow must belong to the org.  If it does not,
     ``can_edit`` is ``False`` — this is absence of permission, not an error.
  2. If the flow belongs to the org, delegate to ``PermissionResolver`` to
     check ``FLOWS / UPDATE`` for the (user, org) pair.  ``PermissionResolver``
     handles the superadmin bypass and raises ``OrgMembershipRequiredError``
     when the user is not a member of the org.  We treat that as ``False``
     (the caller is not in the org ⟹ cannot edit).
"""

from tables.models.graph_models import GraphOrganization
from tables.models.rbac_models.rbac_enums import Permission, ResourceType
from tables.services.rbac.permission_resolver import PermissionResolver
from tables.services.rbac.rbac_exceptions import OrgMembershipRequiredError
from utils.logger import logger


def resolve_can_edit(user, flow_id: int, org_id: int) -> bool:
    """Return ``True`` iff ``user`` may edit ``flow_id`` within ``org_id``.

    Never raises — unexpected errors are logged and treated as ``False``
    (deny on uncertainty is the safer default for an edit-gate).
    """
    try:
        flow_in_org = GraphOrganization.objects.filter(
            graph_id=flow_id, organization_id=org_id
        ).exists()
        if not flow_in_org:
            logger.info(
                "introspect: flow {} not in org {} → can_edit=False",
                flow_id,
                org_id,
            )
            return False

        resolver = PermissionResolver()
        perms = resolver.resolve(user, org_id)
        result = perms.can(ResourceType.FLOWS, Permission.UPDATE)
        logger.debug(
            "introspect: user={} flow={} org={} can_edit={}",
            getattr(user, "id", None),
            flow_id,
            org_id,
            result,
        )
        return result
    except OrgMembershipRequiredError:
        logger.info(
            "introspect: user={} not a member of org={} → can_edit=False",
            getattr(user, "id", None),
            org_id,
        )
        return False
    except Exception:
        # Deny on uncertainty is the safer default for an edit-gate.
        # log with opt(exception=True) so the full traceback is captured —
        # a DB outage and a code bug produce identical behaviour (False) but
        # must be distinguishable in the logs.
        logger.opt(exception=True).error(
            "introspect: unexpected error resolving can_edit user={} flow={} org={}",
            getattr(user, "id", None),
            flow_id,
            org_id,
        )
        return False
