import os
from setuptools import find_packages, setup

root_dir = os.path.dirname(os.path.abspath(__file__))
labext = os.path.join(root_dir, 'jupyterlab_graffiti', 'labextension')
data_files = []
if os.path.isdir(labext):
    for folder, _, files in os.walk(labext):
        if not files:
            continue
        relative = os.path.relpath(folder, labext)
        target = os.path.join('share', 'jupyter', 'labextensions', 'jupyterlab-graffiti')
        if relative != '.':
            target = os.path.join(target, relative)
        sources = []
        for filename in files:
            source = os.path.relpath(os.path.join(folder, filename), root_dir)
            sources.append(source.replace(os.sep, '/'))
        data_files.append((target.replace(os.sep, '/'), sources))

setup(
    name='jupyterlab-graffiti',
    version='0.1.0',
    description='Jupyter Graffiti interactive screencasts for JupyterLab 3.6',
    packages=find_packages(),
    include_package_data=True,
    data_files=data_files,
    python_requires='>=3.8',
    install_requires=['jupyterlab>=3.6,<4', 'ipykernel'],
    zip_safe=False,
)
