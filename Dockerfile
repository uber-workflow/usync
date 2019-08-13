FROM uber/web-base-image:10.15.3

WORKDIR /usync
COPY . /usync/
RUN git config --global user.name "Test MacTesterson" && \
    git config --global user.email "tmac@uber.com" && \
    yarn
