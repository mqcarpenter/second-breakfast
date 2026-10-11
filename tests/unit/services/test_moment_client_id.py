"""Idempotent moment creation via client_id (offline sync)."""

import uuid

import pytest
from sqlmodel import Session, create_engine, select

from app.models.base import BaseModel
from app.models.entry import Entry
from app.models.journal import Journal
from app.models.moment import Moment
from app.models.user import User
from app.schemas.entry import QuillDelta
from app.schemas.moment import MomentCreate, MomentEntryCreate, MomentResponse
from app.services.moment_service import MomentService


@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    BaseModel.metadata.create_all(engine)
    session = Session(engine)
    yield session
    session.close()


def _user(db: Session, name: str) -> User:
    user = User(email=f"{name}_{uuid.uuid4().hex[:6]}@example.com", password="x", name=name)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _journal(db: Session, user: User) -> Journal:
    journal = Journal(user_id=user.id, title="J")
    db.add(journal)
    db.commit()
    db.refresh(journal)
    return journal


def _payload(journal: Journal, client_id=None, text="hello") -> MomentCreate:
    return MomentCreate(
        client_id=client_id,
        entry=MomentEntryCreate(
            title="t",
            content_delta=QuillDelta.model_validate({"ops": [{"insert": text}]}),
            journal_id=journal.id,
        ),
    )


def test_replayed_create_returns_existing_moment(db):
    user = _user(db, "a")
    journal = _journal(db, user)
    service = MomentService(db)
    cid = uuid.uuid4()

    first = service.create_moment(user.id, _payload(journal, cid))
    second = service.create_moment(user.id, _payload(journal, cid, text="changed"))

    assert second.id == first.id
    assert first.client_id == cid
    assert len(db.exec(select(Moment)).all()) == 1
    assert len(db.exec(select(Entry)).all()) == 1


def test_creates_without_client_id_are_independent(db):
    user = _user(db, "a")
    journal = _journal(db, user)
    service = MomentService(db)

    a = service.create_moment(user.id, _payload(journal))
    b = service.create_moment(user.id, _payload(journal))

    assert a.id != b.id
    assert a.client_id is None and b.client_id is None
    assert len(db.exec(select(Moment)).all()) == 2


def test_same_client_id_for_different_users_is_allowed(db):
    alice, bob = _user(db, "alice"), _user(db, "bob")
    cid = uuid.uuid4()
    service = MomentService(db)

    a = service.create_moment(alice.id, _payload(_journal(db, alice), cid))
    b = service.create_moment(bob.id, _payload(_journal(db, bob), cid))

    assert a.id != b.id
    assert a.user_id == alice.id and b.user_id == bob.id


def test_concurrent_duplicate_returns_the_winner(db, monkeypatch):
    """Both requests pass the early lookup, then the unique index rejects the loser."""
    user = _user(db, "a")
    journal = _journal(db, user)
    service = MomentService(db)
    cid = uuid.uuid4()
    winner = service.create_moment(user.id, _payload(journal, cid))

    real_lookup = service._find_by_client_id
    calls = {"n": 0}

    def lookup_misses_first(user_id, client_id):
        calls["n"] += 1
        return None if calls["n"] == 1 else real_lookup(user_id, client_id)

    monkeypatch.setattr(service, "_find_by_client_id", lookup_misses_first)

    loser = service.create_moment(user.id, _payload(journal, cid))

    assert loser.id == winner.id
    assert calls["n"] == 2
    assert len(db.exec(select(Moment)).all()) == 1
    assert len(db.exec(select(Entry)).all()) == 1


def test_response_schema_exposes_client_id():
    assert "client_id" in MomentResponse.model_fields
    assert MomentCreate().client_id is None
