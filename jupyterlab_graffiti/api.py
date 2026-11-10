from ipykernel.comm import Comm

TARGET = 'jupyterlab-graffiti'


def _send(command, **payload):
    data = {'command': command}
    data.update(payload)
    comm = Comm(target_name=TARGET, data=data)
    comm.send(data)
    return comm


def play_recording(recording_id):
    """Start playback of a Graffiti recording or take id."""
    return _send('play', recordingId=recording_id)


def play_recording_with_prompt(recording_id, prompt=''):
    return _send('play', recordingId=recording_id, prompt=prompt)


def stop_playback():
    return _send('stop')


def set_access_level(level):
    return _send('access', level=level)


def transfer_graffiti():
    return _send('transfer')


def package_graffiti(path='jupytergraffiti_data', output='graffiti_package.tar.gz'):
    import os
    import tarfile

    with tarfile.open(output, 'w:gz') as archive:
        if os.path.exists(path):
            archive.add(path)
    return output
