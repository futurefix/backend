const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: "dcelgporn",
  api_key: "426289342321268",
  api_secret: "1r6bVnzH-ub48S6H5MylL01JaPU"
});

module.exports = cloudinary;
