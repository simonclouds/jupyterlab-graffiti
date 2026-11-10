from .api import (
    package_graffiti,
    play_recording,
    play_recording_with_prompt,
    set_access_level,
    stop_playback,
    transfer_graffiti,
)

__version__ = '0.1.0'

__all__ = [
    'package_graffiti',
    'play_recording',
    'play_recording_with_prompt',
    'set_access_level',
    'stop_playback',
    'transfer_graffiti',
]


def _jupyter_labextension_paths():
    return [{
        'src': 'labextension',
        'dest': 'jupyterlab-graffiti',
    }]
