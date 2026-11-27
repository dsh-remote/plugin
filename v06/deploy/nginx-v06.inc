# Include in the TLS vhost that serves drc.provid.cc.
location = /v06 {
    limit_req  zone=drc burst=40 nodelay;
    limit_conn drc_conn 8;
    proxy_pass http://127.0.0.1:8789/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
location /v06/ {
    limit_req  zone=drc burst=40 nodelay;
    limit_conn drc_conn 8;
    proxy_pass http://127.0.0.1:8789/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
}
