# Kong Gateway (OSS, DB-less) with the project's declarative configuration baked in.
# The same image runs locally (docker compose) and in the cloud.
FROM kong:3.9

COPY --chown=kong:kong kong.yml /kong/kong.yml
# render-config.sh keeps its executable bit from the repository.
COPY --chown=kong:kong render-config.sh /kong/render-config.sh

ENV KONG_DATABASE=off \
    KONG_DECLARATIVE_CONFIG=/tmp/kong.yml \
    KONG_PROXY_LISTEN="0.0.0.0:8000" \
    KONG_ADMIN_LISTEN="0.0.0.0:8001" \
    KONG_PROXY_ACCESS_LOG=/dev/stdout \
    KONG_ADMIN_ACCESS_LOG=/dev/stdout \
    KONG_PROXY_ERROR_LOG=/dev/stderr \
    KONG_ADMIN_ERROR_LOG=/dev/stderr

EXPOSE 8000
ENTRYPOINT ["/kong/render-config.sh"]
CMD ["kong", "docker-start"]
