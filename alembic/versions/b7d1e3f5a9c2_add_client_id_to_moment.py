"""Add client_id to moment for idempotent offline creates.

Revision ID: b7d1e3f5a9c2
Revises: a3c5e7f9b1d2
Create Date: 2026-10-11
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "b7d1e3f5a9c2"
down_revision = "a3c5e7f9b1d2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Nullable: existing moments have no client id. Unique indexes treat NULLs as
    # distinct on both PostgreSQL and SQLite, so only real ids are constrained.
    with op.batch_alter_table("moment") as batch_op:
        batch_op.add_column(sa.Column("client_id", sa.Uuid(), nullable=True))
        batch_op.create_index(
            "uq_moment_user_client_id", ["user_id", "client_id"], unique=True
        )


def downgrade() -> None:
    with op.batch_alter_table("moment") as batch_op:
        batch_op.drop_index("uq_moment_user_client_id")
        batch_op.drop_column("client_id")
