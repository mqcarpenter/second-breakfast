"""An implausible weather reading must not abort a Day One import."""
import pytest

from app.data_transfer.dayone.models import DayOneWeather


@pytest.mark.parametrize("value", [72.80000305175781, -150, float("inf"), float("nan")])
def test_out_of_range_temperature_is_dropped(value):
    weather = DayOneWeather.model_validate({"temperatureCelsius": value})
    assert weather.temperature_celsius is None


@pytest.mark.parametrize("value", [-100, 0, 21.5, 70])
def test_valid_temperature_is_kept(value):
    weather = DayOneWeather.model_validate({"temperatureCelsius": value})
    assert weather.temperature_celsius == value


def test_missing_temperature_is_none():
    assert DayOneWeather.model_validate({}).temperature_celsius is None
