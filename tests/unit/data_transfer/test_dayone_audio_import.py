"""Day One audio recordings: parse, map to media, and embed in the entry delta."""
import json
import shutil
import zipfile
from datetime import datetime, timezone

from app.data_transfer.dayone.dayone_parser import DayOneParser
from app.data_transfer.dayone.mappers import DayOneToJournivMapper
from app.data_transfer.dayone.models import DayOneAudio, DayOneEntry
from app.data_transfer.dayone.richtext_parser import DayOneRichTextParser
from app.utils.import_export.temp_paths import get_import_temp_root
from app.utils.import_export.zip_handler import ZipHandler
from app.utils.quill_delta import wrap_dayone_text

AUDIO_ID = "4DA2C5843D2F480183D2ACBB3A3B5297"
AUDIO_MD5 = "2a2a223c26dbaea5de1817e3d3705172"
PHOTO_ID = "73647A1A5FB34D60B69A7458D55F7AC1"
PHOTO_MD5 = "f607f303bf2f86020db00ce9b9da5aaf"

# Shape taken from a real Day One export (iOS 2492).
AUDIO_META = {
    "fileSize": 2606923,
    "orderInEntry": 0,
    "title": "092514-Journal",
    "creationDevice": "iPhone",
    "audioChannels": "Mono",
    "duration": 419.01609375,
    "favorite": False,
    "identifier": AUDIO_ID,
    "format": "aac",
    "height": 0,
    "width": 0,
    "sampleRate": "32.0 kHz",
    "md5": AUDIO_MD5,
    "timeZoneName": "America/Chicago",
}


def _entry(**overrides):
    richtext = {
        "contents": [
            {"attributes": {"line": {"header": 1}}, "text": "New words\n"},
            {"embeddedObjects": [{"type": "photo", "identifier": PHOTO_ID}]},
            {"embeddedObjects": [{"type": "audio", "identifier": AUDIO_ID}]},
        ],
        "meta": {"version": 1},
    }
    data = {
        "uuid": "ENTRY-AUDIO-1",
        "creationDate": "2014-09-25T12:00:00Z",
        "timeZone": "America/Chicago",
        "text": f"# New words\n\n![](dayone-moment://{PHOTO_ID})\n![](dayone-moment:/audio/{AUDIO_ID})",
        "richText": json.dumps(richtext),
        "photos": [{"identifier": PHOTO_ID, "md5": PHOTO_MD5, "type": "png", "orderInEntry": 1}],
        "audios": [AUDIO_META],
    }
    data.update(overrides)
    return DayOneEntry.model_validate(data)


def _media_root(tmp_path):
    root = tmp_path / "extract"
    (root / "audios").mkdir(parents=True)
    (root / "photos").mkdir(parents=True)
    (root / "audios" / f"{AUDIO_MD5}.m4a").write_bytes(b"fake audio")
    (root / "photos" / f"{PHOTO_MD5}.png").write_bytes(b"fake image")
    return root


def test_entry_model_parses_audios():
    entry = _entry()
    assert len(entry.audios) == 1
    audio = entry.audios[0]
    assert isinstance(audio, DayOneAudio)
    assert audio.md5 == AUDIO_MD5
    assert audio.duration == 419.01609375
    assert audio.title == "092514-Journal"


def test_find_media_file_locates_audio_by_md5(tmp_path):
    root = _media_root(tmp_path)
    found = DayOneParser.find_media_file(root, AUDIO_ID, md5_hash=AUDIO_MD5, media_type="audio")
    assert found == root / "audios" / f"{AUDIO_MD5}.m4a"


def test_map_audio_to_media(tmp_path):
    root = _media_root(tmp_path)
    audio = DayOneAudio.model_validate(AUDIO_META)
    dto = DayOneToJournivMapper.map_audio_to_media(
        audio, root / "audios" / f"{AUDIO_MD5}.m4a", "ENTRY-AUDIO-1", media_base_dir=root
    )
    assert dto is not None
    assert dto.media_type == "audio"
    assert dto.mime_type == "audio/mp4"
    assert dto.file_path == f"audios/{AUDIO_MD5}.m4a"
    assert dto.duration == 419.01609375
    assert dto.width is None and dto.height is None
    assert dto.external_asset_id == AUDIO_MD5
    assert dto.external_id == AUDIO_ID


def test_map_audio_missing_file_returns_none(tmp_path):
    audio = DayOneAudio.model_validate(AUDIO_META)
    assert DayOneToJournivMapper.map_audio_to_media(audio, None, "E") is None


def test_map_moment_includes_audio_media(tmp_path):
    root = _media_root(tmp_path)
    moment = DayOneToJournivMapper.map_moment(_entry(), media_dir=root)
    types = sorted(m.media_type for m in moment.media)
    assert types == ["audio", "image"]


def test_richtext_audio_becomes_audio_embed():
    entry = _entry()
    richtext = DayOneRichTextParser.parse_richtext(entry.rich_text)
    delta = DayOneRichTextParser.convert_to_delta(
        richtext, photos=entry.photos, videos=entry.videos, audios=entry.audios
    )
    embeds = [op["insert"] for op in delta["ops"] if isinstance(op["insert"], dict)]
    assert {"image": PHOTO_MD5} in embeds
    assert {"audio": AUDIO_MD5} in embeds


def test_map_entry_delta_keeps_audio_embed():
    dto = DayOneToJournivMapper.map_entry(_entry())
    embeds = [op["insert"] for op in dto.content_delta["ops"] if isinstance(op["insert"], dict)]
    assert {"audio": AUDIO_MD5} in embeds


def test_plain_text_fallback_handles_typed_audio_link():
    entry = _entry(richText=None)
    text = DayOneToJournivMapper._replace_dayone_moment_links(
        entry.text, photos=entry.photos, videos=entry.videos, audios=entry.audios
    )
    assert f"DAYONE_AUDIO:{AUDIO_ID}" in text
    assert f"DAYONE_PHOTO:{PHOTO_ID}" in text
    delta = wrap_dayone_text(text)
    embeds = [op["insert"] for op in delta["ops"] if isinstance(op["insert"], dict)]
    assert {"audio": AUDIO_ID} in embeds


def test_import_metadata_keeps_audios_for_placeholder_map():
    dto = DayOneToJournivMapper.map_entry(_entry())
    raw = dto.import_metadata["raw_dayone"]
    assert raw["audios"][0]["identifier"] == AUDIO_ID
    assert raw["audios"][0]["md5"] == AUDIO_MD5


def test_placeholder_map_resolves_audio(tmp_path):
    from app.services.import_service import ImportService

    root = _media_root(tmp_path)
    entry = _entry()
    dto = DayOneToJournivMapper.map_entry(entry)
    moment = DayOneToJournivMapper.map_moment(entry, media_dir=root)
    mapping = ImportService._build_dayone_placeholder_map(
        dto, moment.media, {AUDIO_ID: "media-audio-uuid", PHOTO_ID: "media-photo-uuid"}
    )
    assert mapping[AUDIO_MD5] == "media-audio-uuid"
    assert mapping[AUDIO_ID] == "media-audio-uuid"


def test_zip_structure_and_stream_extract_include_audios(tmp_path):
    zpath = tmp_path / "export.zip"
    with zipfile.ZipFile(zpath, "w") as z:
        z.writestr("Audio Journal.json", json.dumps({
            "metadata": {"version": "1.0"},
            "entries": [json.loads(_entry().model_dump_json(by_alias=True, exclude_none=True))],
        }))
        z.writestr(f"audios/{AUDIO_MD5}.m4a", b"fake audio")

    info = ZipHandler.validate_zip_structure(zpath, source_type="dayone")
    assert info["has_media"] is True

    extract_to = get_import_temp_root() / f"audio-test-{tmp_path.name}"
    media_dest = tmp_path / "media"
    media_dest.mkdir()
    ZipHandler.stream_extract(
        zpath, extract_to, media_dest=media_dest, validate_media=False, source_type="dayone"
    )
    assert (media_dest / "audios" / f"{AUDIO_MD5}.m4a").exists()


def test_parse_zip_detects_audio_only_media_dir(tmp_path):
    zpath = tmp_path / "export.zip"
    entry = json.loads(_entry(photos=[]).model_dump_json(by_alias=True, exclude_none=True))
    entry["creationDate"] = datetime(2014, 9, 25, tzinfo=timezone.utc).isoformat()
    with zipfile.ZipFile(zpath, "w") as z:
        z.writestr("Audio Journal.json", json.dumps({"metadata": {"version": "1.0"}, "entries": [entry]}))
        z.writestr(f"audios/{AUDIO_MD5}.m4a", b"fake audio")
    journals, media_dir = DayOneParser.parse_zip(
        zpath, get_import_temp_root() / f"audio-parse-{tmp_path.name}"
    )
    assert media_dir is not None
    assert journals[0].entries[0].audios[0].md5 == AUDIO_MD5


def teardown_module(module):
    for p in get_import_temp_root().glob("audio-*"):
        shutil.rmtree(p, ignore_errors=True)


def _write_audio(root, header):
    path = root / "audios" / f"{AUDIO_MD5}.m4a"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(header + b"\x00" * 64)
    return path


def test_mp3_named_m4a_is_renamed_and_typed(tmp_path):
    # Older Day One recordings are MP3 streams saved with an .m4a name.
    path = _write_audio(tmp_path, b"\xff\xfb\x90\x64")
    audio = DayOneAudio.model_validate(AUDIO_META)
    dto = DayOneToJournivMapper.map_audio_to_media(audio, path, "E", media_base_dir=tmp_path)
    assert dto.file_path == f"audios/{AUDIO_MD5}.mp3"
    assert dto.mime_type == "audio/mpeg"
    assert not path.exists()


def test_id3_tagged_mp3_is_renamed(tmp_path):
    path = _write_audio(tmp_path, b"ID3\x03\x00")
    dto = DayOneToJournivMapper.map_audio_to_media(
        DayOneAudio.model_validate(AUDIO_META), path, "E", media_base_dir=tmp_path
    )
    assert dto.file_path.endswith(".mp3")


def test_real_m4a_keeps_extension(tmp_path):
    path = _write_audio(tmp_path, b"\x00\x00\x00\x20ftypM4A ")
    dto = DayOneToJournivMapper.map_audio_to_media(
        DayOneAudio.model_validate(AUDIO_META), path, "E", media_base_dir=tmp_path
    )
    assert dto.file_path == f"audios/{AUDIO_MD5}.m4a"
    assert dto.mime_type == "audio/mp4"


def test_renamed_audio_still_found_for_second_entry(tmp_path):
    # Same recording referenced twice: the second lookup must find the renamed file.
    path = _write_audio(tmp_path, b"\xff\xfb\x90\x64")
    DayOneToJournivMapper.map_audio_to_media(
        DayOneAudio.model_validate(AUDIO_META), path, "E1", media_base_dir=tmp_path
    )
    found = DayOneParser.find_media_file(tmp_path, AUDIO_ID, md5_hash=AUDIO_MD5, media_type="audio")
    assert found == tmp_path / "audios" / f"{AUDIO_MD5}.mp3"
